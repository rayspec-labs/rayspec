// Loads a package whose entry requires a compiled addon. Never deployed: pack refuses the addon.
import addon from 'addon-probe';

export async function probe() {
  return { loaded: typeof addon };
}
