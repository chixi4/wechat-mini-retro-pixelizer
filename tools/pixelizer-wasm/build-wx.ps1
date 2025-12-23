$ErrorActionPreference = "Stop"

$crateRoot = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $crateRoot "..\\..")
$wasmOutDir = Join-Path $repoRoot "miniprogram\\wasm"

$baseTargetDir = Join-Path $crateRoot "target-wasm-base"
$simdTargetDir = Join-Path $crateRoot "target-wasm-simd"

$oldCargoTargetDir = $env:CARGO_TARGET_DIR
$oldRustflags = $env:RUSTFLAGS

try {
  New-Item -ItemType Directory -Force -Path $wasmOutDir | Out-Null

  Push-Location $crateRoot

  Write-Host "[pixelizer-wasm] building baseline wasm..."
  $env:CARGO_TARGET_DIR = $baseTargetDir
  $env:RUSTFLAGS = ""
  cargo build --release --target wasm32-unknown-unknown

  Write-Host "[pixelizer-wasm] building simd wasm..."
  $env:CARGO_TARGET_DIR = $simdTargetDir
  $env:RUSTFLAGS = "-C target-feature=+simd128"
  cargo build --release --target wasm32-unknown-unknown

  $baseWasm = Join-Path $baseTargetDir "wasm32-unknown-unknown\\release\\pixelizer_wasm.wasm"
  $simdWasm = Join-Path $simdTargetDir "wasm32-unknown-unknown\\release\\pixelizer_wasm.wasm"

  if (!(Test-Path $baseWasm)) { throw "baseline wasm not found: $baseWasm" }
  if (!(Test-Path $simdWasm)) { throw "simd wasm not found: $simdWasm" }

  Copy-Item -Force $baseWasm (Join-Path $wasmOutDir "pixelizer.wasm")
  Copy-Item -Force $simdWasm (Join-Path $wasmOutDir "pixelizer_simd.wasm")

  $b = Get-Item (Join-Path $wasmOutDir "pixelizer.wasm")
  $s = Get-Item (Join-Path $wasmOutDir "pixelizer_simd.wasm")
  Write-Host ("[pixelizer-wasm] wrote {0} ({1} bytes)" -f $b.FullName, $b.Length)
  Write-Host ("[pixelizer-wasm] wrote {0} ({1} bytes)" -f $s.FullName, $s.Length)
} finally {
  try { Pop-Location } catch { }
  $env:CARGO_TARGET_DIR = $oldCargoTargetDir
  $env:RUSTFLAGS = $oldRustflags
}
