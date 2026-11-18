export function gachaRecordId(record) {
  const id = String(record?.id)
  if (!/^\d+$/.test(id) || (typeof record.id === "number" && !Number.isSafeInteger(record.id))) {
    throw new Error("抽卡记录存在无效 ID，未写入记录。")
  }
  return BigInt(id).toString()
}

export function mergeGachaRecords(previous, incoming) {
  const records = new Map()
  for (const record of [...previous, ...incoming]) {
    const id = gachaRecordId(record)
    if (!records.has(id)) records.set(id, record)
  }
  return [...records.entries()]
    .sort(([a], [b]) => b.length - a.length || b.localeCompare(a))
    .map(([, record]) => record)
}
