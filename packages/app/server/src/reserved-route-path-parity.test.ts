/**
 * The floor's mirror of the reserved platform paths COVERS what this composition root actually
 * registers — the anti-drift half of the reserved-path rule.
 *
 * `@rayspec/spec` carries `RESERVED_API_PATH_PREFIXES` so `doctor`/`plan`/`deploy --dry-run` and the
 * deploy pipeline's VALIDATE step can refuse a declared route that claims a platform path. It cannot
 * import this package, so the probe half of that list is a KEEP-IN-SYNC copy of what
 * `platformPublicRoutePrefixes` injects into the boot's registrar. A renamed, added or removed probe
 * would leave the floor quietly blind to it; this pins the two together instead.
 *
 * The MOUNT half needs no mirror: both sides derive it from the document through one function
 * (`frontendMountPrefixes`), so there is nothing to drift — what is pinned here is that the root
 * derives it that way rather than keeping a second copy of the canonicalisation.
 *
 * DB-free and boot-free: both sides are pure functions over constants and a document's mounts.
 */
import {
  type FrontendSpec,
  frontendMountPrefixes,
  isReservedApiPath,
  reservedApiPathPrefixes,
  reservedRoutePathRefusal,
} from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_PATH,
  platformPublicRoutePrefixes,
  RECOVERY_SCOPE_PATH,
} from './composition-root.js';

/** Two mounts a document may declare: one nested, one at the root (which reserves nothing). */
const MOUNTS: readonly FrontendSpec[] = [
  { route: '/app', dir: 'web/dist', spa: true, cleanUrls: false },
  { route: '/', dir: 'public', spa: false, cleanUrls: false },
];

/** What the BOOT holds a declared route to: api-auth's own two ⊕ the root's probes ⊕ the mounts. */
const bootReserved = (mounts: readonly FrontendSpec[] = []) => ({
  platform: ['/v1/', '/oidc/', ...platformPublicRoutePrefixes()],
  frontendMounts: frontendMountPrefixes(mounts),
});

describe('the floor covers every path prefix the composition root injects', () => {
  it('covers the probe half for a document with no mounts', () => {
    const floor = reservedApiPathPrefixes();
    expect(platformPublicRoutePrefixes()).toEqual([`${HEALTH_PATH}/`, `${RECOVERY_SCOPE_PATH}/`]);
    for (const injected of platformPublicRoutePrefixes())
      expect(floor.platform).toContain(injected);
  });

  it('covers the declared-mount half too, root mount included (it reserves nothing)', () => {
    const floor = reservedApiPathPrefixes(MOUNTS);
    expect(floor.frontendMounts).toEqual(frontendMountPrefixes(MOUNTS));
    // The root mount is absent from BOTH sides — the exemption is one decision, made in one place.
    expect(floor.frontendMounts).toEqual(['/app/']);
    expect(floor.frontendMounts).not.toContain('/');
    expect(floor.platform).not.toContain('/');
  });

  it('the two sides answer the same way about a route path', () => {
    const floor = reservedApiPathPrefixes(MOUNTS);
    for (const claimed of [HEALTH_PATH, `${RECOVERY_SCOPE_PATH}/deep`, '/app', '/app/config']) {
      expect(isReservedApiPath(claimed, floor)).toBe(true);
      expect(isReservedApiPath(claimed, bootReserved(MOUNTS))).toBe(true);
    }
    // The accept control for the readings above: a merely similar path is claimed by neither.
    expect(isReservedApiPath('/healthy', floor)).toBe(false);
    expect(isReservedApiPath('/healthy', bootReserved(MOUNTS))).toBe(false);
  });

  it('and describe it in the same words — the floor and the boot list the same prefixes', () => {
    // The boot's registrar names its OWN two prefixes ahead of everything the root injects; the floor
    // derives the same list from the document alone. Both feed the one shared sentence, so a document
    // refused by either is refused in text an author and an operator can compare literally.
    expect(reservedRoutePathRefusal('GET', '/app/config', reservedApiPathPrefixes(MOUNTS))).toBe(
      reservedRoutePathRefusal('GET', '/app/config', bootReserved(MOUNTS)),
    );
  });
});
