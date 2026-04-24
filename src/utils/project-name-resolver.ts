const PATH_ENCODED_PREFIX = /^Users-[^-]+-/;

export function resolveProjectName(projectDirName: string): string {
  if (projectDirName === "empty-window") {
    return "general";
  }

  if (/^\d{10,}$/.test(projectDirName)) {
    return `unknown-${projectDirName}`;
  }

  const decoded = projectDirName.replace(PATH_ENCODED_PREFIX, "");
  const parts = decoded.split("-").filter(Boolean);
  if (parts.length === 0) {
    return "unknown";
  }

  // Keep the last 2 fragments to increase readability.
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}-${parts[parts.length - 1]}`.toLowerCase();
  }

  return parts[0].toLowerCase();
}
