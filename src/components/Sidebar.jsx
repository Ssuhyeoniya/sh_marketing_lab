import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { navConfig, findNavMeta } from '../navConfig';

export default function Sidebar() {
  const location = useLocation();
  const meta = findNavMeta(location.pathname);
  const initialOpen = navConfig.reduce((acc, c) => {
    acc[c.id] = meta ? c.id === meta.catId : c.id === 'mockup';
    return acc;
  }, {});
  const [open, setOpen] = useState(initialOpen);

  return (
    <aside className="sidebar">
      <NavLink to="/" className="brand" style={{ display: 'block' }}>
        ⚡ SH Marketing Lab
      </NavLink>
      {navConfig.map((cat) => (
        <div key={cat.id} className={`cat ${open[cat.id] ? 'open' : ''}`}>
          <div
            className="cat-head"
            onClick={() => setOpen({ ...open, [cat.id]: !open[cat.id] })}
          >
            <span>{cat.label}</span>
            <span>{open[cat.id] ? '▾' : '▸'}</span>
          </div>
          <div className="cat-items">
            {cat.items.map((it) => (
              <NavLink
                key={it.path}
                to={it.path}
                className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
              >
                <span>{it.label}</span>
                {it.badge && <span className="badge">{it.badge}</span>}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
