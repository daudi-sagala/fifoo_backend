function requireTextArray(value, fieldName) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${fieldName} must be an array of strings.`);
  }
  return value;
}

export function mealSeedInsertValues({
  id,
  title,
  calories,
  description,
  mealTypes,
  tags,
}) {
  return [
    id,
    title,
    calories,
    description,
    requireTextArray(mealTypes, 'mealTypes'),
    requireTextArray(tags, 'tags'),
  ];
}
