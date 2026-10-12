/**
 * DeviceLog — the bridge's view of what the MACHINE itself has recorded.
 *
 * Requirement: displayed logID = how many times this employee scanned on the
 * device, taken from the MACHINE's data — never invented by the bridge.
 *
 * The machine's authoritative record identity is its raw punch line
 * ("userId\tseconds\tstatus\tverify…"). We:
 *   • ingest every distinct raw line exactly once (retransmitted identical
 *     lines are the same device log entry → deduped)
 *   • keep the machine's arrival ORDER per (device, employee), and
 *     deviceLogId = position in that order = the Nth time this employee has
 *     scanned on this device, as reflected by the machine's own transmissions.
 */
class DeviceLog {
  constructor() {
    this.bySn = new Map();   // sn -> { lines:Set, records:[] }
  }

  /**
   * Ingest a batch exactly as the machine reported it.
   * @returns newly ingested records (deduped by the machine's own raw log line)
   */
  ingest(sn, records) {
    if (!this.bySn.has(sn)) this.bySn.set(sn, { lines: new Set(), records: [] });
    const store = this.bySn.get(sn);
    const fresh = [];
    for (const r of records) {
      const key = r.raw; // the machine's own raw punch line (its identity)
      if (store.lines.has(key)) continue; // device retransmission of the same log
      store.lines.add(key);
      store.records.push(r);
      fresh.push(r);
    }
    return fresh;
  }

  /** Total distinct device-log entries for a device. */
  count(sn) {
    const s = this.bySn.get(sn);
    return s ? s.records.length : 0;
  }

  /** Last n distinct entries for a device. */
  recent(sn, n) {
    const s = this.bySn.get(sn);
    return s ? s.records.slice(-n) : [];
  }
}

module.exports = { DeviceLog };
