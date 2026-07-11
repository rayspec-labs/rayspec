// The RaySpec platform binding subpath (`@rayspec/audio-runtime/rayspec`). Turns the neutral
// capability core into declared routes/handlers behind RaySpec's real auth/tenancy chain. Kept behind a
// subpath so the package ROOT (`@rayspec/audio-runtime`) stays free of any platform binding concern.
export * from './handlers.js';
export * from './mount.js';
