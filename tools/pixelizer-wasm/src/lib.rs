use core::cmp::Ordering;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::ptr;
use std::mem;

const PALETTE_CACHE_BITS: u32 = 6;
const PALETTE_CACHE_SHIFT: u32 = 8 - PALETTE_CACHE_BITS;
const PALETTE_CACHE_SIZE: usize = 1 << (PALETTE_CACHE_BITS * 3);

const DITHER_NEAREST: u32 = 0;
const DITHER_ATKINSON: u32 = 1;
const DITHER_FLOYD: u32 = 2;
const DITHER_BAYER4: u32 = 3;
const DITHER_BAYER8: u32 = 4;
const DITHER_RANDOM: u32 = 5;

#[repr(C)]
#[derive(Copy, Clone)]
struct ToneStats {
  pivot: f64,
  p5: u8,
  p50: u8,
  p95: u8,
  range: f64
}

struct State {
  w: usize,
  h: usize,
  base: Vec<u8>,
  work: Vec<u8>,
  tone_stats: Option<ToneStats>,

  palette_r: Vec<u8>,
  palette_g: Vec<u8>,
  palette_b: Vec<u8>,
  palette_len: usize,

  cache: Vec<i16>,

  // xorshift rng state
  rng: u32,

  bayer4_factor: [f32; 16],
  bayer8_factor: [f32; 64]
}

impl State {
  fn new() -> Self {
    let mut bayer4_factor = [0.0f32; 16];
    for i in 0..16 {
      bayer4_factor[i] = ((i as f32) / 16.0 - 0.5) * 30.0;
    }

    let mut bayer8_factor = [0.0f32; 64];
    for i in 0..64 {
      bayer8_factor[i] = ((i as f32) / 64.0 - 0.5) * 30.0;
    }

    Self {
      w: 0,
      h: 0,
      base: Vec::new(),
      work: Vec::new(),
      tone_stats: None,
      palette_r: Vec::new(),
      palette_g: Vec::new(),
      palette_b: Vec::new(),
      palette_len: 0,
      cache: vec![-1; PALETTE_CACHE_SIZE],
      rng: 0x1234_5678,
      bayer4_factor,
      bayer8_factor
    }
  }

  fn ensure_cache_reset(&mut self) {
    for v in self.cache.iter_mut() {
      *v = -1;
    }
  }

  fn set_palette(&mut self, rgb_bytes: &[u8], len: usize) -> bool {
    if len == 0 {
      self.palette_len = 0;
      self.palette_r.clear();
      self.palette_g.clear();
      self.palette_b.clear();
      self.ensure_cache_reset();
      return true;
    }

    if rgb_bytes.len() < len * 3 {
      return false;
    }

    self.palette_r.resize(len, 0);
    self.palette_g.resize(len, 0);
    self.palette_b.resize(len, 0);

    for i in 0..len {
      self.palette_r[i] = rgb_bytes[i * 3];
      self.palette_g[i] = rgb_bytes[i * 3 + 1];
      self.palette_b[i] = rgb_bytes[i * 3 + 2];
    }

    self.palette_len = len;
    self.ensure_cache_reset();
    true
  }

  fn set_base(&mut self, rgba: &[u8], w: usize, h: usize) -> bool {
    let expected = w
      .checked_mul(h)
      .and_then(|v| v.checked_mul(4))
      .unwrap_or(0);
    if expected == 0 || rgba.len() < expected {
      return false;
    }

    self.w = w;
    self.h = h;
    self.base.clear();
    self.base.extend_from_slice(&rgba[..expected]);
    self.work.resize(expected, 0);
    self.tone_stats = None;
    true
  }

  #[inline]
  fn color_distance_sq(r1: i32, g1: i32, b1: i32, r2: i32, g2: i32, b2: i32) -> i32 {
    let rmean = (r1 + r2) >> 1;
    let r = r1 - r2;
    let g = g1 - g2;
    let b = b1 - b2;
    (((512 + rmean) * r * r) >> 8) + (4 * g * g) + (((767 - rmean) * b * b) >> 8)
  }

  #[inline]
  fn nearest_palette_index(&mut self, r: u8, g: u8, b: u8) -> usize {
    let key = (((r as usize) >> (PALETTE_CACHE_SHIFT as usize)) << ((PALETTE_CACHE_BITS as usize) * 2))
      | (((g as usize) >> (PALETTE_CACHE_SHIFT as usize)) << (PALETTE_CACHE_BITS as usize))
      | ((b as usize) >> (PALETTE_CACHE_SHIFT as usize));

    let cached = self.cache[key];
    if cached >= 0 {
      return cached as usize;
    }

    let r1 = r as i32;
    let g1 = g as i32;
    let b1 = b as i32;

    let mut best = 0usize;
    let mut best_dist: i32 = i32::MAX;

    for i in 0..self.palette_len {
      let dist = Self::color_distance_sq(
        r1,
        g1,
        b1,
        self.palette_r[i] as i32,
        self.palette_g[i] as i32,
        self.palette_b[i] as i32
      );
      if dist < best_dist {
        best_dist = dist;
        best = i;
        if dist == 0 {
          break;
        }
      }
    }

    self.cache[key] = best as i16;
    best
  }
}

static mut STATE_PTR: *mut State = core::ptr::null_mut();

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
  unsafe {
    if STATE_PTR.is_null() {
      STATE_PTR = Box::into_raw(Box::new(State::new()));
    }
    f(&mut *STATE_PTR)
  }
}

#[inline]
fn clamp01(v: f64) -> f64 {
  if !(v > 0.0) {
    return 0.0;
  }
  if v > 1.0 {
    return 1.0;
  }
  v
}

#[inline]
fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
  if (edge0 - edge1).abs() < f64::EPSILON {
    return if x < edge0 { 0.0 } else { 1.0 };
  }
  let t = clamp01((x - edge0) / (edge1 - edge0));
  t * t * (3.0 - 2.0 * t)
}

#[inline]
fn clamp_round_u8(v: f64) -> u8 {
  if !v.is_finite() {
    if v.is_nan() {
      return 0;
    }
    return if v.is_sign_negative() { 0 } else { 255 };
  }
  if v <= 0.0 {
    return 0;
  }
  if v >= 255.0 {
    return 255;
  }

  let floor = v.floor();
  let frac = v - floor;
  let mut n = floor as u16;
  match frac.partial_cmp(&0.5) {
    Some(Ordering::Greater) => n += 1,
    Some(Ordering::Equal) => {
      if (n & 1) == 1 {
        n += 1;
      }
    }
    _ => {}
  }
  n as u8
}

fn compute_tone_stats(data: &[u8], w: usize, h: usize) -> ToneStats {
  let mut hist = [0u32; 256];

  let total_pixels = w.saturating_mul(h);
  let target_samples = 32_768usize;
  let step_pixels = core::cmp::max(1, total_pixels / target_samples);
  let step_bytes = step_pixels * 4;

  let mut samples = 0usize;
  let mut i = 0usize;
  while i + 2 < data.len() {
    let r = data[i] as f64;
    let g = data[i + 1] as f64;
    let b = data[i + 2] as f64;
    let l = (0.299 * r + 0.587 * g + 0.114 * b) as i32;
    let l = l.clamp(0, 255) as usize;
    hist[l] = hist[l].wrapping_add(1);
    samples += 1;
    i = i.saturating_add(step_bytes);
  }

  if samples == 0 {
    return ToneStats {
      pivot: 0.5,
      p5: 0,
      p50: 128,
      p95: 255,
      range: 1.0
    };
  }

  let pct = |q: f64| -> u8 {
    let target = ((q * (samples as f64)) + 0.5).floor() as u32;
    let target = target.clamp(1, samples as u32);
    let mut cum = 0u32;
    for (i, v) in hist.iter().enumerate() {
      cum = cum.wrapping_add(*v);
      if cum >= target {
        return i as u8;
      }
    }
    255
  };

  let p5 = pct(0.05);
  let p50 = pct(0.5);
  let p95 = pct(0.95);

  let range = ((p95 as f64) - (p5 as f64)) / 255.0;
  let pivot = clamp01((p50 as f64) / 255.0);

  ToneStats {
    pivot,
    p5,
    p50,
    p95,
    range
  }
}

fn apply_dynamic_tone_mapping(data: &mut [u8], tone_x: f64, tone_y: f64, stats: ToneStats) {
  let pivot_raw = stats.pivot;
  let range = stats.range;
  let p5_raw = stats.p5 as f64;
  let p95_raw = stats.p95 as f64;

  let strength = clamp01(tone_x.abs().max(tone_y.abs()));
  let guard = 1.0 + (3.0 * strength).round();
  let guard_i = guard as i32;
  let eps = guard / 255.0;
  let lo = eps;
  let hi = 1.0 - eps;

  let clamp = |val: f64, min: f64, max: f64| val.max(min).min(max);
  let logit = |v: f64| (v / (1.0 - v)).ln();
  let inv_logit = |t: f64| 1.0 / (1.0 + (-t).exp());

  let pivot = clamp(pivot_raw, 0.05, 0.95);
  let pivot_safe = clamp(pivot, lo, hi);
  let lp = logit(pivot_safe);

  let contrast_confidence = smoothstep(0.18, 0.75, range);

  let target_guard = guard + (5.0 * strength).round();
  let lo_t = clamp(target_guard / 255.0, lo, 0.45);
  let hi_t = clamp(1.0 - target_guard / 255.0, 0.55, hi);
  let l_lo = logit(lo_t);
  let l_hi = logit(hi_t);

  let v5 = clamp(p5_raw / 255.0, lo, hi);
  let v95 = clamp(p95_raw / 255.0, lo, hi);
  let t5 = logit(v5);
  let t95 = logit(v95);
  let d5 = t5 - lp;
  let d95 = t95 - lp;

  let mut c_max: f64 = 8.0;
  if d95 > 1e-6 {
    c_max = c_max.min((l_hi - lp) / d95);
  }
  if d5 < -1e-6 {
    c_max = c_max.min((l_lo - lp) / d5);
  }
  c_max = clamp(c_max, 1.0, 8.0);

  let x_curve = tone_x.signum() * tone_x.abs().powf(1.25);
  let x_scale = 1.0 + (1.0 - contrast_confidence) * 0.3;
  let x_eff = clamp(x_curve * x_scale, -1.0, 1.0);
  let x_sat = (x_eff * 1.25).tanh() / (1.25_f64).tanh();
  let contrast_max = 2.12;
  let c_wanted = 2_f64.powf(x_sat * contrast_max);
  let c = c_wanted.min(c_max);

  let y_curve = tone_y.signum() * tone_y.abs().powf(1.6);
  let y_scale = 1.0 + contrast_confidence * 0.5;
  let dir_scale_raw = if tone_y >= 0.0 {
    1.0 + (0.5 - pivot_safe) * 0.9
  } else {
    1.0 + (pivot_safe - 0.5) * 0.9
  };
  let dir_scale = clamp(dir_scale_raw, 0.9, 1.25);
  let y_eff = clamp(y_curve * y_scale * dir_scale, -1.0, 1.0);
  let y_sat = (y_eff * 1.15).tanh() / (1.15_f64).tanh();

  let y_range_t = clamp01(tone_x + 1.0);
  let y_range_scale = 0.62 + 0.38 * y_range_t;

  let b_max = (2.55 + 0.85 * contrast_confidence) * y_range_scale;
  let brightness_range_scale = 0.7;
  let b_base = y_sat * b_max * brightness_range_scale;
  let y_weight_pow = 1.05;

  let mut luma_lut = [0.0f32; 256];
  for i in 0..256 {
    let v = clamp((i as f64) / 255.0, lo, hi);
    let mut t = (logit(v) - lp) * c + lp;

    if b_base != 0.0 {
      let vc = inv_logit(t);
      let w = if b_base > 0.0 {
        (1.0 - vc).powf(y_weight_pow)
      } else {
        vc.powf(y_weight_pow)
      };
      t += b_base * w;
    }

    let out = clamp(inv_logit(t), lo, hi);
    luma_lut[i] = (out * 255.0) as f32;
  }

  let edge_width = 0.3;
  let sat_edge_strength = 0.78;
  let min_sat = 1.0 - sat_edge_strength * strength;
  let delta_k = 0.9 + 2.2 * strength;

  let mut sat_lut = [0.0f32; 256];
  for i in 0..256 {
    let nl = luma_lut[i] as f64;
    let nl01 = nl / 255.0;
    let d_edge = nl01.min(1.0 - nl01);

    let mut t = d_edge / edge_width;
    t = clamp01(t);
    let edge_w = t * t * (3.0 - 2.0 * t);

    let sat_edge = min_sat + (1.0 - min_sat) * edge_w;

    let d_l = (nl - (i as f64)).abs() / 255.0;
    let sat_delta = (-d_l * delta_k).exp();
    let sat_delta_edge = edge_w + (1.0 - edge_w) * sat_delta;

    sat_lut[i] = clamp01(sat_edge * sat_delta_edge) as f32;
  }

  let lower = guard_i;
  let upper = 255 - guard_i;

  let len = data.len();
  let mut idx = 0usize;
  while idx + 2 < len {
    let r0 = data[idx] as i32;
    let g0 = data[idx + 1] as i32;
    let b0 = data[idx + 2] as i32;

    let l = ((77 * r0 + 150 * g0 + 29 * b0) >> 8).clamp(0, 255) as usize;
    let nl = luma_lut[l] as f64;

    let dr = (r0 - (l as i32)) as f64;
    let dg = (g0 - (l as i32)) as f64;
    let db = (b0 - (l as i32)) as f64;

    let mut sat = 1.0f64;

    if dr > 0.0 {
      sat = sat.min(((upper as f64) - nl) / dr);
    } else if dr < 0.0 {
      sat = sat.min(((lower as f64) - nl) / dr);
    }

    if dg > 0.0 {
      sat = sat.min(((upper as f64) - nl) / dg);
    } else if dg < 0.0 {
      sat = sat.min(((lower as f64) - nl) / dg);
    }

    if db > 0.0 {
      sat = sat.min(((upper as f64) - nl) / db);
    } else if db < 0.0 {
      sat = sat.min(((lower as f64) - nl) / db);
    }

    if !(sat > 0.0) {
      sat = 0.0;
    } else if sat > 1.0 {
      sat = 1.0;
    }

    sat *= sat_lut[l] as f64;

    let r_adj = nl + dr * sat;
    let g_adj = nl + dg * sat;
    let b_adj = nl + db * sat;

    data[idx] = clamp_round_u8(r_adj);
    data[idx + 1] = clamp_round_u8(g_adj);
    data[idx + 2] = clamp_round_u8(b_adj);

    idx += 4;
  }
}

const BAYER_MAP4: [[u8; 4]; 4] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

const BAYER_MAP8: [[u8; 8]; 8] = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21]
];

fn dither_nearest(state: &mut State, data: &mut [u8]) {
  let len = data.len();
  let mut i = 0usize;
  while i + 2 < len {
    let idx = state.nearest_palette_index(data[i], data[i + 1], data[i + 2]);
    data[i] = state.palette_r[idx];
    data[i + 1] = state.palette_g[idx];
    data[i + 2] = state.palette_b[idx];
    i += 4;
  }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn clamp_round_fixed_pow2(n: i32, shift: u32) -> u8 {
  if n <= 0 {
    return 0;
  }
  let max_n = 255i32 << shift;
  if n >= max_n {
    return 255;
  }

  // n in (0, 255<<shift), so it's positive.
  let q = n >> shift;
  let r = n & ((1i32 << shift) - 1);
  let half = 1i32 << (shift - 1);

  if r < half {
    return q as u8;
  }
  if r > half {
    return (q + 1) as u8;
  }
  if (q & 1) == 1 {
    return (q + 1) as u8;
  }
  q as u8
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn add_error_pow2(base: u8, err: i32, num: i32, shift: u32) -> u8 {
  let n = ((base as i32) << shift) + err * num;
  clamp_round_fixed_pow2(n, shift)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
unsafe fn add_error_pixel_pow2_simd(data: &mut [u8], i: usize, err_r: i32, err_g: i32, err_b: i32, num: i32, shift: u32) {
  let r0 = data[i] as i16;
  let g0 = data[i + 1] as i16;
  let b0 = data[i + 2] as i16;
  let a0 = data[i + 3] as i16;

  let base = i16x8(r0, g0, b0, a0, 0, 0, 0, 0);
  let err = i16x8(err_r as i16, err_g as i16, err_b as i16, 0, 0, 0, 0, 0);
  let numv = i16x8_splat(num as i16);

  let n = i16x8_add(i16x8_shl(base, shift), i16x8_mul(err, numv));

  let zero = i16x8_splat(0);
  let ones = i16x8_splat(1);
  let max_n = i16x8_splat((255i32 << shift) as i16);
  let max_out = i16x8_splat(255);

  let q = i16x8_shr(n, shift);
  let rem_mask = i16x8_splat(((1i32 << shift) - 1) as i16);
  let rem = v128_and(n, rem_mask);
  let half = i16x8_splat((1i32 << (shift - 1)) as i16);

  let gt_half = i16x8_gt(rem, half);
  let eq_half = i16x8_eq(rem, half);
  let q_odd = i16x8_eq(v128_and(q, ones), ones);
  let inc_mask = v128_or(gt_half, v128_and(eq_half, q_odd));
  let rounded = v128_bitselect(i16x8_add(q, ones), q, inc_mask);

  let res = v128_bitselect(
    zero,
    v128_bitselect(max_out, rounded, i16x8_ge(n, max_n)),
    i16x8_le(n, zero)
  );

  let packed = u8x16_narrow_i16x8(res, zero);
  let word = u32x4_extract_lane::<0>(packed);
  ptr::write_unaligned(data.as_mut_ptr().add(i) as *mut u32, word);
}

#[inline(always)]
fn add_error_pixel_pow2(data: &mut [u8], i: usize, err_r: i32, err_g: i32, err_b: i32, num: i32, shift: u32) {
  #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
  unsafe {
    add_error_pixel_pow2_simd(data, i, err_r, err_g, err_b, num, shift);
    return;
  }

  #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
  {
    data[i] = add_error_pow2(data[i], err_r, num, shift);
    data[i + 1] = add_error_pow2(data[i + 1], err_g, num, shift);
    data[i + 2] = add_error_pow2(data[i + 2], err_b, num, shift);
  }
}

fn dither_random(state: &mut State, data: &mut [u8], seed: u32) {
  // xorshift32
  let mut rng = if seed != 0 { seed } else { state.rng };
  let len = data.len();
  let mut i = 0usize;
  while i + 2 < len {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    let noise = ((rng % 31) as i32) - 15;

    let r = (data[i] as i32 + noise).clamp(0, 255) as u8;
    let g = (data[i + 1] as i32 + noise).clamp(0, 255) as u8;
    let b = (data[i + 2] as i32 + noise).clamp(0, 255) as u8;

    let idxp = state.nearest_palette_index(r, g, b);
    data[i] = state.palette_r[idxp];
    data[i + 1] = state.palette_g[idxp];
    data[i + 2] = state.palette_b[idxp];

    i += 4;
  }
  state.rng = rng;
}

fn dither_bayer(state: &mut State, data: &mut [u8], map_size: usize) {
  let w = state.w;
  let h = state.h;
  if w == 0 || h == 0 {
    return;
  }

  for y in 0..h {
    let row_offset = y * w * 4;
    if map_size == 8 {
      let map_row = &BAYER_MAP8[y % 8];
      for x in 0..w {
        let i = row_offset + x * 4;
        let map_value = map_row[x % 8] as usize;
        let f = state.bayer8_factor[map_value] as f64;

        let r = (data[i] as f64 + f).max(0.0).min(255.0) as u8;
        let g = (data[i + 1] as f64 + f).max(0.0).min(255.0) as u8;
        let b = (data[i + 2] as f64 + f).max(0.0).min(255.0) as u8;

        let idxp = state.nearest_palette_index(r, g, b);
        data[i] = state.palette_r[idxp];
        data[i + 1] = state.palette_g[idxp];
        data[i + 2] = state.palette_b[idxp];
      }
    } else {
      let map_row = &BAYER_MAP4[y % 4];
      for x in 0..w {
        let i = row_offset + x * 4;
        let map_value = map_row[x % 4] as usize;
        let f = state.bayer4_factor[map_value] as f64;

        let r = (data[i] as f64 + f).max(0.0).min(255.0) as u8;
        let g = (data[i + 1] as f64 + f).max(0.0).min(255.0) as u8;
        let b = (data[i + 2] as f64 + f).max(0.0).min(255.0) as u8;

        let idxp = state.nearest_palette_index(r, g, b);
        data[i] = state.palette_r[idxp];
        data[i + 1] = state.palette_g[idxp];
        data[i + 2] = state.palette_b[idxp];
      }
    }
  }
}

fn dither_atkinson(state: &mut State, data: &mut [u8], serpentine: bool) {
  let w = state.w;
  let h = state.h;
  if w == 0 || h == 0 {
    return;
  }

  // factor = 1/8
  let shift = 3u32;
  let num = 1i32;
  let stride = w * 4;
  let stride2 = stride * 2;

  for y in 0..h {
    let reverse = serpentine && ((y & 1) == 1);
    let row0 = y * stride;
    let has_y1 = y + 1 < h;
    let row1 = row0 + stride;
    let has_y2 = y + 2 < h;
    let row2 = row0 + stride2;

    if !reverse {
      for x in 0..w {
        let i = row0 + x * 4;
        let old_r = data[i];
        let old_g = data[i + 1];
        let old_b = data[i + 2];

        let idxp = state.nearest_palette_index(old_r, old_g, old_b);
        let new_r = state.palette_r[idxp];
        let new_g = state.palette_g[idxp];
        let new_b = state.palette_b[idxp];

        data[i] = new_r;
        data[i + 1] = new_g;
        data[i + 2] = new_b;

        let err_r = (old_r as i32) - (new_r as i32);
        let err_g = (old_g as i32) - (new_g as i32);
        let err_b = (old_b as i32) - (new_b as i32);

        if x + 1 < w {
          add_error_pixel_pow2(data, i + 4, err_r, err_g, err_b, num, shift);
        }
        if x + 2 < w {
          add_error_pixel_pow2(data, i + 8, err_r, err_g, err_b, num, shift);
        }

        if has_y1 {
          if x > 0 {
            add_error_pixel_pow2(data, row1 + (x - 1) * 4, err_r, err_g, err_b, num, shift);
          }
          add_error_pixel_pow2(data, row1 + x * 4, err_r, err_g, err_b, num, shift);
          if x + 1 < w {
            add_error_pixel_pow2(data, row1 + (x + 1) * 4, err_r, err_g, err_b, num, shift);
          }
        }

        if has_y2 {
          add_error_pixel_pow2(data, row2 + x * 4, err_r, err_g, err_b, num, shift);
        }
      }
    } else {
      let mut x = w;
      while x > 0 {
        x -= 1;
        let i = row0 + x * 4;
        let old_r = data[i];
        let old_g = data[i + 1];
        let old_b = data[i + 2];

        let idxp = state.nearest_palette_index(old_r, old_g, old_b);
        let new_r = state.palette_r[idxp];
        let new_g = state.palette_g[idxp];
        let new_b = state.palette_b[idxp];

        data[i] = new_r;
        data[i + 1] = new_g;
        data[i + 2] = new_b;

        let err_r = (old_r as i32) - (new_r as i32);
        let err_g = (old_g as i32) - (new_g as i32);
        let err_b = (old_b as i32) - (new_b as i32);

        if x >= 1 {
          add_error_pixel_pow2(data, i - 4, err_r, err_g, err_b, num, shift);
        }
        if x >= 2 {
          add_error_pixel_pow2(data, i - 8, err_r, err_g, err_b, num, shift);
        }

        if has_y1 {
          if x + 1 < w {
            add_error_pixel_pow2(data, row1 + (x + 1) * 4, err_r, err_g, err_b, num, shift);
          }
          add_error_pixel_pow2(data, row1 + x * 4, err_r, err_g, err_b, num, shift);
          if x >= 1 {
            add_error_pixel_pow2(data, row1 + (x - 1) * 4, err_r, err_g, err_b, num, shift);
          }
        }

        if has_y2 {
          add_error_pixel_pow2(data, row2 + x * 4, err_r, err_g, err_b, num, shift);
        }
      }
    }
  }
}

fn dither_floyd(state: &mut State, data: &mut [u8], serpentine: bool) {
  let w = state.w;
  let h = state.h;
  if w == 0 || h == 0 {
    return;
  }

  let shift = 4u32; // /16
  let stride = w * 4;

  for y in 0..h {
    let reverse = serpentine && ((y & 1) == 1);
    let row0 = y * stride;
    let has_y1 = y + 1 < h;
    let row1 = row0 + stride;

    if !reverse {
      for x in 0..w {
        let i = row0 + x * 4;
        let old_r = data[i];
        let old_g = data[i + 1];
        let old_b = data[i + 2];

        let idxp = state.nearest_palette_index(old_r, old_g, old_b);
        let new_r = state.palette_r[idxp];
        let new_g = state.palette_g[idxp];
        let new_b = state.palette_b[idxp];

        data[i] = new_r;
        data[i + 1] = new_g;
        data[i + 2] = new_b;

        let err_r = (old_r as i32) - (new_r as i32);
        let err_g = (old_g as i32) - (new_g as i32);
        let err_b = (old_b as i32) - (new_b as i32);

        // (1,0) 7/16
        if x + 1 < w {
          add_error_pixel_pow2(data, i + 4, err_r, err_g, err_b, 7, shift);
        }

        if has_y1 {
          // (-1,1) 3/16
          if x > 0 {
            add_error_pixel_pow2(data, row1 + (x - 1) * 4, err_r, err_g, err_b, 3, shift);
          }
          // (0,1) 5/16
          add_error_pixel_pow2(data, row1 + x * 4, err_r, err_g, err_b, 5, shift);
          // (1,1) 1/16
          if x + 1 < w {
            add_error_pixel_pow2(data, row1 + (x + 1) * 4, err_r, err_g, err_b, 1, shift);
          }
        }
      }
    } else {
      let mut x = w;
      while x > 0 {
        x -= 1;
        let i = row0 + x * 4;
        let old_r = data[i];
        let old_g = data[i + 1];
        let old_b = data[i + 2];

        let idxp = state.nearest_palette_index(old_r, old_g, old_b);
        let new_r = state.palette_r[idxp];
        let new_g = state.palette_g[idxp];
        let new_b = state.palette_b[idxp];

        data[i] = new_r;
        data[i + 1] = new_g;
        data[i + 2] = new_b;

        let err_r = (old_r as i32) - (new_r as i32);
        let err_g = (old_g as i32) - (new_g as i32);
        let err_b = (old_b as i32) - (new_b as i32);

        // (-1,0) 7/16
        if x >= 1 {
          add_error_pixel_pow2(data, i - 4, err_r, err_g, err_b, 7, shift);
        }

        if has_y1 {
          // (1,1) 3/16
          if x + 1 < w {
            add_error_pixel_pow2(data, row1 + (x + 1) * 4, err_r, err_g, err_b, 3, shift);
          }
          // (0,1) 5/16
          add_error_pixel_pow2(data, row1 + x * 4, err_r, err_g, err_b, 5, shift);
          // (-1,1) 1/16
          if x >= 1 {
            add_error_pixel_pow2(data, row1 + (x - 1) * 4, err_r, err_g, err_b, 1, shift);
          }
        }
      }
    }
  }
}

fn render_inner(
  state: &mut State,
  tone_x: f64,
  tone_y: f64,
  dither_algo: u32,
  serpentine: bool,
  seed: u32
) -> bool {
  if state.base.is_empty() || state.palette_len == 0 || state.w == 0 || state.h == 0 {
    return false;
  }

  state.work.copy_from_slice(&state.base);

  if tone_x != 0.0 || tone_y != 0.0 {
    if state.tone_stats.is_none() {
      let stats = compute_tone_stats(&state.base, state.w, state.h);
      state.tone_stats = Some(stats);
    }
    apply_dynamic_tone_mapping(&mut state.work, tone_x, tone_y, state.tone_stats.unwrap());
  }

  let mut work = mem::take(&mut state.work);
  match dither_algo {
    DITHER_NEAREST => dither_nearest(state, &mut work),
    DITHER_ATKINSON => dither_atkinson(state, &mut work, serpentine),
    DITHER_FLOYD => dither_floyd(state, &mut work, serpentine),
    DITHER_BAYER4 => dither_bayer(state, &mut work, 4),
    DITHER_BAYER8 => dither_bayer(state, &mut work, 8),
    DITHER_RANDOM => dither_random(state, &mut work, seed),
    _ => dither_nearest(state, &mut work)
  };
  state.work = work;

  true
}

#[no_mangle]
pub extern "C" fn is_simd() -> u32 {
  #[cfg(target_feature = "simd128")]
  {
    return 1;
  }
  #[cfg(not(target_feature = "simd128"))]
  {
    return 0;
  }
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> u32 {
  let len = len as usize;
  let mut buf = Vec::<u8>::with_capacity(len);
  let ptr = buf.as_mut_ptr();
  mem::forget(buf);
  ptr as u32
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: u32, len: u32) {
  if ptr == 0 || len == 0 {
    return;
  }
  unsafe {
    let _ = Vec::<u8>::from_raw_parts(ptr as *mut u8, 0, len as usize);
  }
}

#[no_mangle]
pub extern "C" fn set_palette(ptr: u32, len: u32) -> u32 {
  let bytes_len = (len as usize).saturating_mul(3);
  if ptr == 0 || len == 0 {
    return with_state(|state| {
      state.palette_len = 0;
      state.palette_r.clear();
      state.palette_g.clear();
      state.palette_b.clear();
      state.ensure_cache_reset();
      1
    });
  }

  unsafe {
    let bytes = core::slice::from_raw_parts(ptr as *const u8, bytes_len);
    let ok = with_state(|state| state.set_palette(bytes, len as usize));
    ok as u32
  }
}

#[no_mangle]
pub extern "C" fn set_base(ptr: u32, len: u32, w: u32, h: u32) -> u32 {
  if ptr == 0 || len == 0 || w == 0 || h == 0 {
    return 0;
  }
  unsafe {
    let bytes = core::slice::from_raw_parts(ptr as *const u8, len as usize);
    let ok = with_state(|state| state.set_base(bytes, w as usize, h as usize));
    ok as u32
  }
}

#[no_mangle]
pub extern "C" fn render(
  tone_x: f64,
  tone_y: f64,
  dither_algo: u32,
  serpentine: u32,
  seed: u32
) -> u32 {
  let ok = with_state(|state| render_inner(state, tone_x, tone_y, dither_algo, serpentine != 0, seed));
  if !ok {
    return 0;
  }
  with_state(|state| state.work.as_ptr() as u32)
}

#[no_mangle]
pub extern "C" fn work_len() -> u32 {
  with_state(|state| state.work.len() as u32)
}
