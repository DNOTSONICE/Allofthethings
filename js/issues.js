// Loads the Issue dropdown choices from data/issues.json.

let cache = null;

// Resolves with [{ name, issues: [...] }]. A plain "issues" list (the older format) becomes one unnamed group.
export async function loadIssueGroups() {
  if (!cache) {
    cache = fetch('./data/issues.json')
      .then((r) => r.json())
      .then((d) => (d.groups ? d.groups : [{ name: '', issues: d.issues }]))
      .catch(() => {
        cache = null;
        return [{ name: '', issues: ['Other'] }];
      });
  }
  return cache;
}
