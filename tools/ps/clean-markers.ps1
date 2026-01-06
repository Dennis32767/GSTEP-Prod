# clean-markers.ps1
$ErrorActionPreference = 'Stop'

# Gather candidate source files (exclude build output & caches)
$files = Get-ChildItem -Recurse -File -Include *.js,*.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\build\\|\\.next\\|\\out\\|\\artifacts\\|\\cache\\' }

if (-not $files) { Write-Host "No source files found."; exit 0 }

[int]$changed = 0
foreach ($f in $files) {
  $txt = Get-Content $f.FullName -Raw

  # pattern A: " - file.js:123"
  $txt2 = [regex]::Replace($txt, '\s*-\s*[A-Za-z0-9._-]+\.js:[0-9]+\b', '')
  # pattern B: "(file.js:123)"
  $txt2 = [regex]::Replace($txt2, '\s*\(\s*[A-Za-z0-9._-]+\.js:[0-9]+\s*\)', '')

  if ($txt2 -ne $txt) {
    [System.IO.File]::WriteAllText($f.FullName, $txt2, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Cleaned: $($f.FullName)"
    $changed++
  }
}

Write-Host "`nFiles modified: $changed"

# Re-scan quickly for any remaining markers
$remaining = Select-String -Path ($files | Select-Object -Expand FullName) -Pattern '-\s*[A-Za-z0-9._-]+\.js:[0-9]+\b','\(\s*[A-Za-z0-9._-]+\.js:[0-9]+\s*\)' -ErrorAction SilentlyContinue
if ($remaining) {
  Write-Host "`nStill found markers in:" -ForegroundColor Yellow
  $remaining | Sort-Object Path, LineNumber | Format-Table -AutoSize
  exit 3
} else {
  Write-Host "`nAll markers removed." -ForegroundColor Green
}
