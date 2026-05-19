export const navConfig = [
  {
    id: 'convert',
    label: '변환',
    items: [
      { path: '/convert/pdf-word', label: 'PDF ↔ Word' },
      { path: '/convert/pdf-excel', label: 'PDF ↔ Excel' },
      { path: '/convert/pdf-ppt', label: 'PDF ↔ PowerPoint' },
      { path: '/convert/pdf-image', label: 'PDF ↔ Image' },
      { path: '/convert/svg-png', label: 'SVG ↔ PNG' },
      { path: '/convert/pdf-ocr', label: 'PDF OCR' },
    ],
  },
  {
    id: 'organize',
    label: '정리',
    items: [
      { path: '/organize/merge', label: '병합' },
      { path: '/organize/split', label: '분할' },
      { path: '/organize/rotate', label: '회전' },
      { path: '/organize/delete-pages', label: '페이지 삭제' },
      { path: '/organize/extract-pages', label: '페이지 추출' },
    ],
  },
  {
    id: 'edit',
    label: '편집',
    items: [
      { path: '/edit/text', label: '텍스트 편집', badge: 'OCR' },
      { path: '/edit/crop', label: '자르기' },
      { path: '/edit/watermark', label: '워터마크' },
      { path: '/edit/page-numbers', label: '페이지 번호' },
    ],
  },
  {
    id: 'mockup',
    label: '목업',
    items: [
      { path: '/mockup/iphone', label: '아이폰', badge: 'HOT' },
      { path: '/mockup/web', label: '웹' },
    ],
  },
];

export function findNavMeta(pathname) {
  for (const cat of navConfig) {
    for (const it of cat.items) {
      if (it.path === pathname) return { category: cat.label, item: it.label, catId: cat.id };
    }
  }
  return null;
}
