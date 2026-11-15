/** Small pulsing ember with a satellite dot orbiting it; the caption stays quiet. Pure CSS, honours reduced motion. */
export function Ember({ caption }: { caption?: string }) {
  return (
    <span className="ember" aria-label={caption ?? 'Loading'}>
      <span className="ember__orbit" aria-hidden="true">
        <span className="ember__core" />
        <span className="ember__sat" />
      </span>
      {caption && <span className="ember__caption">{caption}</span>}
    </span>
  );
}
