// The source envelope and the stored replica have different digest domains.
export function replicaContentMatches(receipt, stored) {
  return Boolean(receipt?.contentDigest && stored?.contentDigest === receipt.contentDigest);
}
