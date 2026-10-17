import type { Ecosystem } from '../model/types.js';
import { goPlugin } from './go/index.js';
import { mavenPlugin } from './maven/index.js';
import { npmPlugin } from './npm/index.js';
import { nugetPlugin } from './nuget/index.js';
import { packagistPlugin } from './packagist/index.js';
import { pypiPlugin } from './pypi/index.js';
import type { EcosystemPlugin } from './types.js';

/** Register new ecosystems here — see docs/adding-an-ecosystem.md. */
export const defaultPlugins: readonly EcosystemPlugin[] = [
  npmPlugin,
  pypiPlugin,
  packagistPlugin,
  mavenPlugin,
  goPlugin,
  nugetPlugin,
];

export function pluginFor(
  ecosystem: Ecosystem,
  plugins: readonly EcosystemPlugin[] = defaultPlugins,
): EcosystemPlugin | undefined {
  return plugins.find((p) => p.id === ecosystem);
}
