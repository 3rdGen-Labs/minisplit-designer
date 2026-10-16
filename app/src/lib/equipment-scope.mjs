/** Smart Multi three-phase is outside this project's residential V1 scope. */
export function isExcludedSmartMulti(model, phase = "") {
  return /^MXZ-SM/i.test(String(model).trim()) &&
    (String(phase).trim() === "3-phase" || /^MXZ-SM(?:\d+T|-TL)/i.test(String(model).trim()));
}

/** Remove dedicated three-phase models/series and their exclusive accessories, retaining shared data. */
export function scopeEquipmentData(data) {
  const excluded = (value) => typeof value === "string" &&
    (isExcludedSmartMulti(value) || /^CMR-M100KT(?:1)?-NA$/.test(value.trim()) || value.trim() === "CMY-Y62-GA-E");
  if (Array.isArray(data)) {
    return data.filter((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return !excluded(row);
      if (isExcludedSmartMulti(row.strModelNumber, row.strPhase)) return false;
      return !Object.values(row).some(excluded);
    }).map(scopeEquipmentData);
  }
  if (data && typeof data === "object") {
    return Object.fromEntries(Object.entries(data)
      .filter(([key]) => key !== "shutoff_valve_kits" && !excluded(key))
      .map(([key, value]) => [key, scopeEquipmentData(value)]));
  }
  return data;
}
