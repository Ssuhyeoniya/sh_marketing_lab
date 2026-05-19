export default function Stepper({ steps, current }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className={'step ' + (i < current ? 'done' : i === current ? 'active' : '')}>
            <span className="n">{i < current ? '✓' : i + 1}</span> {s}
          </span>
          {i < steps.length - 1 && <span className="arr">›</span>}
        </span>
      ))}
    </div>
  );
}
