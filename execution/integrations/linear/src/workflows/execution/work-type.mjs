export const WORK_TYPES = Object.freeze(["code", "non_code"]);

export function requiredResourceKindForWorkType(workType) {
  if (workType === "code") return "git_repo";
  return null;
}
