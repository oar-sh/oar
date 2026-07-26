export function normalizeModelSelectorOptions(models = [], {
  autoValue = 'auto',
  labelFor = (modelId) => modelId,
} = {}) {
  const normalizedAuto = String(autoValue || 'auto').trim() || 'auto';
  const values = Array.from(new Set(
    (Array.isArray(models) ? models : [])
      .map((modelId) => String(modelId || '').trim())
      .filter(Boolean),
  )).filter((modelId) => modelId.toLowerCase() !== normalizedAuto.toLowerCase());
  values.sort((left, right) => {
    const labelOrder = String(labelFor(left) || left).localeCompare(
      String(labelFor(right) || right),
      undefined,
      { sensitivity: 'base', numeric: true },
    );
    return labelOrder || left.localeCompare(right);
  });
  return [
    { value: normalizedAuto, label: String(labelFor(normalizedAuto) || normalizedAuto) },
    ...values.map((value) => ({ value, label: String(labelFor(value) || value) })),
  ];
}

export function modelSelectorOptionsEqual(currentOptions = [], nextOptions = []) {
  return currentOptions.length === nextOptions.length
    && nextOptions.every((option, index) => (
      currentOptions[index]?.value === option.value
      && currentOptions[index]?.label === option.label
    ));
}
