function parseCliFlags(args) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
        flags[arg.slice(2)] = true;
      } else {
        flags[arg.slice(2)] = args[index + 1];
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function hasCliFlag(flags, name) {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

export {
  flagValue,
  hasCliFlag,
  parseCliFlags,
};