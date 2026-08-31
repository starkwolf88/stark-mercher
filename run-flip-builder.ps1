while ($true) {
    node determine-flips.mjs
    npm run build
    Start-Sleep -Seconds 180
}
