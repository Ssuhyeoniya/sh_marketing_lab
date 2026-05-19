import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { findNavMeta } from '../navConfig';

export default function Layout() {
  const location = useLocation();
  const meta = findNavMeta(location.pathname);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile drawer on route change
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  return (
    <div className="app">
      <Sidebar mobileOpen={mobileOpen} />
      {mobileOpen && (
        <div
          className="sidebar-backdrop"
          style={{ display: 'block' }}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="main">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="mobile-menu-btn btn sm"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="메뉴"
            >
              ☰
            </button>
            <div className="crumb">
              {meta ? <>{meta.category} / <b>{meta.item}</b></> : <b>홈</b>}
            </div>
          </div>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
