const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function getErrCode(result) {
  if (!result) return null;
  if (typeof result.errCode === "number") return result.errCode;
  if (typeof result.errcode === "number") return result.errcode;
  return null;
}

function getErrMsg(result) {
  if (!result) return "";
  return result.errMsg || result.errmsg || "";
}

function normalizeSuggestStatus(suggest) {
  if (suggest === "pass") return "pass";
  if (suggest === "review") return "review";
  if (suggest === "risky") return "reject";
  return "error";
}

async function handleImage(event) {
  const fileID = event && event.fileID ? String(event.fileID) : "";
  if (!fileID) {
    return { ok: false, status: "error", errMsg: "missing fileID" };
  }

  const contentType = event && event.contentType ? String(event.contentType) : "image/jpeg";

  try {
    const download = await cloud.downloadFile({ fileID });
    const buffer = download && download.fileContent ? download.fileContent : null;
    if (!buffer) {
      return { ok: false, status: "error", errMsg: "empty file content" };
    }

    const checkRes = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType,
        value: buffer
      }
    });

    const errCode = getErrCode(checkRes);
    let status = "pass";
    if (errCode === 0 || errCode === null) {
      status = "pass";
    } else if (errCode === 87014) {
      status = "reject";
    } else {
      status = "error";
    }

    return {
      ok: status === "pass",
      status,
      errCode,
      errMsg: getErrMsg(checkRes)
    };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      errCode: getErrCode(err),
      errMsg: getErrMsg(err) || String(err && err.message ? err.message : err)
    };
  } finally {
    try {
      await cloud.deleteFile({ fileList: [fileID] });
    } catch (e) {
      // ignore cleanup failures
    }
  }
}

async function handleText(event) {
  const content = event && event.content != null ? String(event.content) : "";
  if (!content) {
    return { ok: false, status: "error", errMsg: "missing content" };
  }

  const scene = event && typeof event.scene === "number" ? event.scene : 2;
  const title = event && event.title != null ? String(event.title) : "";
  const nickname = event && event.nickname != null ? String(event.nickname) : "";
  const signature = event && event.signature != null ? String(event.signature) : "";

  const wxContext = cloud.getWXContext ? cloud.getWXContext() : {};
  const openid = wxContext && wxContext.OPENID ? wxContext.OPENID : "";
  if (!openid) {
    return { ok: false, status: "error", errMsg: "missing openid" };
  }

  try {
    const payload = {
      openid,
      scene,
      version: 2,
      content
    };
    if (title) payload.title = title;
    if (nickname) payload.nickname = nickname;
    if (signature) payload.signature = signature;

    const checkRes = await cloud.openapi.security.msgSecCheck(payload);
    const errCode = getErrCode(checkRes);
    const traceId = checkRes && (checkRes.trace_id || checkRes.traceId) ? checkRes.trace_id || checkRes.traceId : "";

    if (errCode !== 0 && errCode !== null) {
      return {
        ok: false,
        status: "error",
        errCode,
        errMsg: getErrMsg(checkRes),
        traceId
      };
    }

    const suggest = checkRes && checkRes.result && checkRes.result.suggest ? checkRes.result.suggest : "";
    const status = normalizeSuggestStatus(suggest);
    return {
      ok: status === "pass",
      status,
      errCode,
      errMsg: getErrMsg(checkRes),
      traceId,
      result: checkRes.result,
      detail: checkRes.detail
    };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      errCode: getErrCode(err),
      errMsg: getErrMsg(err) || String(err && err.message ? err.message : err)
    };
  }
}

exports.main = async (event) => {
  const action = event && event.action ? String(event.action) : "";
  if (action === "image") {
    return handleImage(event);
  }
  if (action === "text") {
    return handleText(event);
  }
  return { ok: false, status: "error", errMsg: "unsupported action" };
};
