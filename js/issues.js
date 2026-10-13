// Loads the Issue dropdown choices from data/issues.json.

let cache = null;

export async function loadIssues() {
  if (!cache) {
    cache = fetch('./data/issues.json')
      .then((r) => r.json())
      .then((d) => d.issues)
      .catch(() => {
        cache = null;
        return ['Other'];
      });
  }
  return cache;
}
