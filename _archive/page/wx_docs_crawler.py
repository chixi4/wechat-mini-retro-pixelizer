#!/usr/bin/env python3
"""微信小程序开发文档爬虫 - 将文档镜像为本地 Markdown 文件"""

from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import logging
import os
import posixpath
import random
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urldefrag, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup, FeatureNotFound
import markdownify

LOG = logging.getLogger("wx_docs_crawler")

ALLOWED_HOST = "developers.weixin.qq.com"
SCOPE_PREFIX = "/miniprogram/dev/"
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf", ".zip"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()


def sanitize(segment: str) -> str:
    segment = re.sub(r'[<>:"/\\|?*]+', "_", segment).rstrip(" .")
    return segment or "_"


def normalize_url(base: str, href: str) -> Optional[tuple[str, Optional[str]]]:
    href = (href or "").strip()
    if not href or href.startswith(("mailto:", "tel:", "javascript:")):
        return None
    absolute, fragment = urldefrag(urljoin(base, href))
    parts = urlsplit(absolute)
    if parts.scheme not in ("http", "https"):
        return None
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    normalized = urlunsplit((parts.scheme, parts.netloc.lower(), path, "", ""))
    return normalized, fragment or None


def in_scope(url: str) -> bool:
    parts = urlsplit(url)
    if parts.netloc.lower() != ALLOWED_HOST:
        return False
    if not parts.path.startswith(SCOPE_PREFIX):
        return False
    _, ext = posixpath.splitext(parts.path)
    return ext.lower() not in SKIP_EXT


def url_to_path(url: str, out: Path) -> Path:
    parts = urlsplit(url)
    path = posixpath.normpath(parts.path or "/")
    if not path.startswith("/"):
        path = "/" + path
    segments = [sanitize(s) for s in path.strip("/").split("/") if s]
    local = out.joinpath(*segments) if segments else out
    if parts.path.endswith("/"):
        return local / "index.md"
    base, ext = posixpath.splitext(segments[-1]) if segments else ("index", "")
    if ext.lower() == ".html":
        return out.joinpath(*segments[:-1], base + ".md") if segments else out / "index.md"
    return local.with_suffix(".md")


class RateLimiter:
    def __init__(self, rps: float):
        self._interval = 1.0 / rps if rps > 0 else 0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def wait(self):
        if self._interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            scheduled = max(now, self._next)
            self._next = scheduled + self._interval
            delay = scheduled - now
        if delay > 0:
            await asyncio.sleep(delay)


def soup(html: str) -> BeautifulSoup:
    try:
        return BeautifulSoup(html, "lxml")
    except FeatureNotFound:
        return BeautifulSoup(html, "html.parser")


def extract_links(html: str, page_url: str) -> set[str]:
    links = set()
    s = soup(html)
    for a in s.find_all("a", href=True):
        result = normalize_url(page_url, a.get("href", ""))
        if result:
            links.add(result[0])
    for m in re.finditer(r'["\'](/miniprogram/dev/[a-zA-Z0-9_./-]+)["\']', html):
        result = normalize_url(page_url, m.group(1))
        if result:
            links.add(result[0])
    return links


def pick_container(s: BeautifulSoup) -> Any:
    for sel in ["article", "main", "div.markdown-body", "div#content", "div.content"]:
        for el in s.select(sel):
            if len(el.get_text(" ", strip=True)) > 200:
                return el
    return s.body or s


def clean_container(container: Any):
    for tag in container.find_all(["script", "style", "noscript", "footer", "nav"]):
        tag.decompose()
    for el in container.find_all(class_=re.compile(r"(footer|copyright|sidebar|nav-)", re.I)):
        el.decompose()
    for el in container.find_all(string=re.compile(r"Copyright.*Tencent", re.I)):
        parent = el.find_parent()
        if parent:
            parent.decompose()


def rewrite_links(container: Any, page_url: str, out: Path):
    current = url_to_path(page_url, out)
    for a in container.find_all("a", href=True):
        result = normalize_url(page_url, a.get("href", ""))
        if not result or not in_scope(result[0]):
            continue
        url, frag = result
        if frag and url == page_url:
            a["href"] = f"#{frag}"
            continue
        target = url_to_path(url, out)
        rel = os.path.relpath(target, current.parent).replace(os.sep, "/")
        a["href"] = f"{rel}#{frag}" if frag else rel


def to_markdown(html_frag: str) -> str:
    md = markdownify.markdownify(html_frag, heading_style="ATX", code_language_callback=lambda el: "")
    return re.sub(r"\n{3,}", "\n\n", md).strip() + "\n"


def write_file(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


@dataclass
class Config:
    out: Path
    starts: list[str]
    rps: float = 1.0
    concurrency: int = 6
    timeout: float = 30.0
    retries: int = 5
    max_pages: int = 0
    download_assets: bool = False
    ua: str = "wx-docs-crawler/1.0"


@dataclass
class State:
    seen: set[str] = field(default_factory=set)
    todo: set[str] = field(default_factory=set)
    fails: dict[str, str] = field(default_factory=dict)


class Crawler:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = State()
        self.limiter = RateLimiter(cfg.rps)
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.scheduled: set[str] = set()
        self.saved = 0
        self.manifest: list[dict] = []
        self._lock = asyncio.Lock()
        self.robots: Optional[RobotFileParser] = None

    async def enqueue(self, url: str):
        if url in self.scheduled:
            return
        self.scheduled.add(url)
        self.state.todo.add(url)
        await self.queue.put(url)

    async def fetch(self, client: httpx.AsyncClient, url: str, headers: dict) -> httpx.Response:
        for attempt in range(self.cfg.retries + 1):
            await self.limiter.wait()
            await asyncio.sleep(random.uniform(0, 0.2))
            try:
                resp = await client.get(url, headers=headers, timeout=self.cfg.timeout)
                if resp.status_code in (429, 503) or resp.status_code >= 500:
                    if attempt >= self.cfg.retries:
                        resp.raise_for_status()
                    delay = min(60, 2 ** attempt) + random.uniform(0, 0.5)
                    LOG.warning(f"Status {resp.status_code} for {url}, retry in {delay:.1f}s")
                    await asyncio.sleep(delay)
                    continue
                return resp
            except (httpx.RequestError, httpx.HTTPStatusError) as e:
                if attempt >= self.cfg.retries:
                    raise
                delay = min(60, 2 ** attempt) + random.uniform(0, 0.5)
                LOG.warning(f"Error {e} for {url}, retry in {delay:.1f}s")
                await asyncio.sleep(delay)
        raise RuntimeError("Should not reach here")

    async def load_robots(self, client: httpx.AsyncClient):
        url = f"https://{ALLOWED_HOST}/robots.txt"
        try:
            resp = await self.fetch(client, url, {"User-Agent": self.cfg.ua})
            if resp.status_code == 200:
                rp = RobotFileParser()
                rp.set_url(url)
                rp.parse(resp.text.splitlines())
                self.robots = rp
        except Exception as e:
            LOG.warning(f"Failed to load robots.txt: {e}")

    def robots_ok(self, url: str) -> bool:
        return self.robots.can_fetch(self.cfg.ua, url) if self.robots else True

    async def process(self, client: httpx.AsyncClient, url: str):
        if not in_scope(url) or not self.robots_ok(url):
            self.state.seen.add(url)
            return

        headers = {"User-Agent": self.cfg.ua, "Accept": "text/html"}
        resp = await self.fetch(client, url, headers)
        final_url = str(resp.url)
        self.scheduled.add(final_url)

        ct = resp.headers.get("Content-Type", "")
        if "text/html" not in ct:
            self.state.seen.add(url)
            return

        html = resp.text
        s = soup(html)
        container = pick_container(s)
        clean_container(container)

        rewrite_links(container, final_url, self.cfg.out)

        if self.cfg.download_assets:
            await self.mirror_images(client, container, final_url)

        title = ""
        h1 = container.find("h1")
        if h1:
            title = h1.get_text(" ", strip=True)
        if not title and s.title:
            title = s.title.string or ""
        title = title.strip() or "Untitled"

        md = to_markdown(str(container))
        if not md.lstrip().startswith("#"):
            md = f"# {title}\n\n{md}"

        front = f"---\nsource: {final_url}\ntitle: {title}\ndate: {utc_now()}\n---\n\n"
        out_path = url_to_path(final_url, self.cfg.out)
        write_file(out_path, front + md)

        self.saved += 1
        self.manifest.append({"url": final_url, "path": str(out_path), "title": title})
        self.state.seen.add(url)
        self.state.seen.add(final_url)
        self.state.todo.discard(url)

        LOG.info(f"[{self.saved}] {title[:50]} -> {out_path}")

        for link in extract_links(html, final_url):
            if self.cfg.max_pages and self.saved >= self.cfg.max_pages:
                break
            if in_scope(link) and link not in self.state.seen and self.robots_ok(link):
                await self.enqueue(link)

    async def mirror_images(self, client: httpx.AsyncClient, container: Any, page_url: str):
        assets = self.cfg.out / "_assets"
        assets.mkdir(parents=True, exist_ok=True)
        page_md = url_to_path(page_url, self.cfg.out)

        for img in container.find_all("img", src=True):
            src = (img.get("src") or "").strip()
            if not src:
                continue
            result = normalize_url(page_url, src)
            if not result:
                continue
            img_url = result[0]
            _, ext = posixpath.splitext(urlsplit(img_url).path)
            ext = (ext or ".bin").lower()
            name = f"{sha1(img_url)}{ext}"
            path = assets / name

            if not path.exists():
                try:
                    resp = await self.fetch(client, img_url, {"User-Agent": self.cfg.ua})
                    if resp.status_code == 200:
                        path.write_bytes(resp.content)
                except Exception as e:
                    LOG.warning(f"Image download failed {img_url}: {e}")
                    continue

            rel = os.path.relpath(path, page_md.parent).replace(os.sep, "/")
            img["src"] = rel

    async def worker(self, client: httpx.AsyncClient, wid: int):
        while True:
            url = await self.queue.get()
            try:
                if url in self.state.seen:
                    continue
                if self.cfg.max_pages and self.saved >= self.cfg.max_pages:
                    continue
                await self.process(client, url)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.state.fails[url] = str(e)
                LOG.error(f"Worker {wid} failed on {url}: {e}")
            finally:
                self.queue.task_done()

    async def run(self):
        self.cfg.out.mkdir(parents=True, exist_ok=True)
        for u in self.cfg.starts:
            await self.enqueue(u)

        limits = httpx.Limits(max_connections=self.cfg.concurrency)
        async with httpx.AsyncClient(follow_redirects=True, limits=limits) as client:
            await self.load_robots(client)
            workers = [asyncio.create_task(self.worker(client, i)) for i in range(self.cfg.concurrency)]
            await self.queue.join()
            for w in workers:
                w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

        manifest_path = self.cfg.out / "_manifest.json"
        write_file(manifest_path, json.dumps({
            "generated": utc_now(),
            "total_pages": self.saved,
            "pages": self.manifest
        }, ensure_ascii=False, indent=2))

        LOG.info(f"完成: 共保存 {self.saved} 个页面, 失败 {len(self.state.fails)} 个")


def main():
    p = argparse.ArgumentParser(description="微信小程序文档爬虫")
    p.add_argument("--out", default="wx_mp_docs", help="输出目录")
    p.add_argument("--start", action="append", default=[], help="起始URL")
    p.add_argument("--rps", type=float, default=1.0, help="每秒请求数")
    p.add_argument("--concurrency", type=int, default=6, help="并发数")
    p.add_argument("--max-pages", type=int, default=0, help="最大页面数(0=无限)")
    p.add_argument("--download-assets", action="store_true", help="下载图片")
    p.add_argument("--verbose", "-v", action="store_true", help="详细日志")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s: %(message)s"
    )

    starts = args.start or ["https://developers.weixin.qq.com/miniprogram/dev/framework/"]
    cfg = Config(
        out=Path(args.out),
        starts=starts,
        rps=args.rps,
        concurrency=args.concurrency,
        max_pages=args.max_pages,
        download_assets=args.download_assets
    )

    try:
        asyncio.run(Crawler(cfg).run())
    except KeyboardInterrupt:
        LOG.warning("用户中断")


if __name__ == "__main__":
    main()
