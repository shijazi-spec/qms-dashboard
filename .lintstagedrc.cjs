module.exports = {
  "*.ts": (stagedFiles) => [
    `prettier --write ${stagedFiles.map((f) => `"${f}"`).join(" ")}`,
    "npm run check --silent",
  ],
};
