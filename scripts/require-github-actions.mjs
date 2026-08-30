if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("Metis deployments are allowed only from the GitHub Actions main-branch workflow.");
  process.exit(1);
}
