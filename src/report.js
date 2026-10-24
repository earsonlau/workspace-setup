/**
 * @param {ReturnType<import("./plan.js").planSetup>} plan
 */
export function formatReport(plan) {
  const lines = [
    `workspace: ${plan.workspace}`,
    `source:    ${plan.source}`,
    `config:    ${plan.configPath}${plan.origin === "defaults" ? " (defaults)" : ""}`,
    "",
    "copy:",
  ];
  if (plan.copies.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of plan.copies) {
      if (item.action === "copy" || item.action === "overwrite") {
        lines.push(`  ${item.rel}  ${item.action}`);
      } else {
        lines.push(`  ${item.rel}  ${item.action}  ${item.reason}`);
      }
    }
  }
  lines.push("", "install:");
  if (plan.install.skipped) {
    lines.push(`  skipped  ${plan.install.reason}`);
  } else if (plan.install.commands.length === 0) {
    lines.push(`  (none)  ${plan.install.reason}`);
  } else {
    for (const command of plan.install.commands) {
      const via = plan.install.lockfile ? `  lockfile ${plan.install.lockfile}` : "";
      lines.push(`  ${command}${via}`);
    }
  }
  lines.push("", "trust:");
  for (const action of plan.trust) {
    if (action.action === "run") {
      lines.push(`  ${action.tool}  run  ${action.command}  ${action.config}`);
    } else {
      lines.push(`  ${action.tool}  skip  ${action.reason}`);
    }
  }
  const counts = summarize(plan);
  lines.push(
    "",
    `summary: ${counts.copy} copy, ${counts.overwrite} overwrite, ${counts.skip} skip, ${counts.absent} absent, ${counts.install} install, ${counts.trust} trust`,
  );
  if (counts.install > 0 || counts.trust > 0) {
    lines.push(
      "note: trust and install run again on every apply; pass --skip-trust and --skip-install to copy files only",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {ReturnType<import("./plan.js").planSetup>} plan
 */
export function summarize(plan) {
  const count = (action) => plan.copies.filter((item) => item.action === action).length;
  return {
    copy: count("copy"),
    overwrite: count("overwrite"),
    skip: count("skip"),
    absent: count("absent"),
    install: plan.install.skipped ? 0 : plan.install.commands.length,
    trust: plan.trust.filter((action) => action.action === "run").length,
  };
}
