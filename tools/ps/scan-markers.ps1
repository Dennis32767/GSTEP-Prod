# scan-markers.ps1
$ErrorActionPreference = 'Stop'

# Patterns to look for
$patterns = @(
  'deployGemStepEnv\.js:[0-9]+',          # specific
  '-\s*[A-Za-z0-9._-]+\.js:[0-9]+\b',     # " - file.js:123" suffix
  '\(\s*[A-Za-z0-9._-]+\.js:[0-9]+\s*\)'  # "(file.js:123)" suffix
)

# Gather candidate source files (exclude build output & caches)
$files = Get-ChildItem -Recurse -File -Include *.js,*.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\build\\|\\.next\\|\\out\\|\\artifacts\\|\\cache\\' }

if (-not $files) { Write-Host "No source files found."; exit 0 }

# Search
$hits = @()
foreach ($p in $patterns) {
  $res = Select-String -Path ($files | Select-Object -Expand FullName) -Pattern $p -SimpleMatch -ErrorAction SilentlyContinue
  if ($res) { $hits += $res }
}

if ($hits) {
  $hits | Sort-Object Path, LineNumber | Format-Table -AutoSize
  exit 2
} else {
  Write-Host "No markers found."
}
