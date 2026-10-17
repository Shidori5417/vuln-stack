import type { Ecosystem } from '../model/types.js';
import { cargoPlugin } from './cargo/index.js';
import { goPlugin } from './go/index.js';
import { hexPlugin } from './hex/index.js';
import { mavenPlugin } from './maven/index.js';
import { npmPlugin } from './npm/index.js';
import { nugetPlugin } from './nuget/index.js';
import { packagistPlugin } from './packagist/index.js';
import { pubPlugin } from './pub/index.js';
import { pypiPlugin } from './pypi/index.js';
import { rubygemsPlugin } from './rubygems/index.js';
import { swiftPlugin } from './swift/index.js';
import type { EcosystemPlugin } from './types.js';

/** Register new ecosystems here — see docs/adding-an-ecosystem.md. */
export const defaultPlugins: readonly EcosystemPlugin[] = [
  npmPlugin,
  pypiPlugin,
  packagistPlugin,
  mavenPlugin,
  goPlugin,
  nugetPlugin,
  rubygemsPlugin,
  cargoPlugin,
  hexPlugin,
  pubPlugin,
  swiftPlugin,
];

export function pluginFor(
  ecosystem: Ecosystem,
  plugins: readonly EcosystemPlugin[] = defaultPlugins,
): EcosystemPlugin | undefined {
  return plugins.find((p) => p.id === ecosystem);
}
