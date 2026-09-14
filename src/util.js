export const Enum = (...args) =>
{
  const result = {};
  for (let i = 0; i < args.length; ++i)
  {
    const key = args[i];
    if (!isNaN(key))
    {
      throw new Error(`Enum key "${key}" cannot be a number.`);
    }
    result[result[i] = key] = i;
  }
  return Object.freeze(result);
};