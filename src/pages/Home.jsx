import { Link } from 'react-router-dom';

const quick = [
  { to: '/mockup/iphone', emoji: '📱', title: '아이폰 목업', desc: '이미지 끼워넣기 · 최대 20장 ZIP' },
  { to: '/edit/text', emoji: '✎', title: '텍스트 편집 (OCR)', desc: '동일 폰트로 텍스트 수정' },
  { to: '/convert/pdf-image', emoji: '⇄', title: 'PDF ↔ Image', desc: 'PDF/PNG/JPG 양방향 변환' },
  { to: '/organize/merge', emoji: '⊞', title: '병합 / 분할', desc: 'PDF 페이지 정리' },
];

export default function Home() {
  return (
    <div className="content">
      <div
        style={{
          background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
          color: '#fff',
          borderRadius: 14,
          padding: '28px 32px',
          marginBottom: 22,
        }}
      >
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>한 곳에서 끝내는 파일 작업 · 목업 생성</h1>
        <p style={{ fontSize: 14, opacity: 0.92 }}>
          PDF / Image 변환부터 OCR 기반 텍스트 편집, 아이폰 목업 일괄 생성까지.
        </p>
      </div>

      <h2 style={{ fontSize: 15, margin: '20px 0 12px' }}>빠른 시작</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        {quick.map((q) => (
          <Link
            key={q.to}
            to={q.to}
            style={{
              background: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 18,
              transition: 'all .15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#3b82f6';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '';
              e.currentTarget.style.transform = '';
            }}
          >
            <div
              style={{
                width: 38, height: 38, borderRadius: 9,
                background: '#eff6ff', color: '#3b82f6',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, marginBottom: 12,
              }}
            >{q.emoji}</div>
            <h3 style={{ fontSize: 14, marginBottom: 4 }}>{q.title}</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
