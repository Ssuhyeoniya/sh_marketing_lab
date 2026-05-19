import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { findNavMeta } from '../navConfig';

export default function Layout() {
  const location = useLocation();
  const meta = findNavMeta(location.pathname);
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <div className="topbar">
          <div>
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
