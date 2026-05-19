import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import PdfWord from './pages/convert/PdfWord';
import PdfExcel from './pages/convert/PdfExcel';
import PdfPpt from './pages/convert/PdfPpt';
import PdfImage from './pages/convert/PdfImage';
import SvgPng from './pages/convert/SvgPng';
import PdfOcrPage from './pages/convert/PdfOcr';
import Merge from './pages/organize/Merge';
import Split from './pages/organize/Split';
import Rotate from './pages/organize/Rotate';
import DeletePages from './pages/organize/DeletePages';
import ExtractPages from './pages/organize/ExtractPages';
import TextEdit from './pages/edit/TextEdit';
import Crop from './pages/edit/Crop';
import Watermark from './pages/edit/Watermark';
import PageNumbers from './pages/edit/PageNumbers';
import IphoneMockup from './pages/mockup/IphoneMockup';
import WebMockup from './pages/mockup/WebMockup';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/convert/pdf-word" element={<PdfWord />} />
        <Route path="/convert/pdf-excel" element={<PdfExcel />} />
        <Route path="/convert/pdf-ppt" element={<PdfPpt />} />
        <Route path="/convert/pdf-image" element={<PdfImage />} />
        <Route path="/convert/svg-png" element={<SvgPng />} />
        <Route path="/convert/pdf-ocr" element={<PdfOcrPage />} />
        <Route path="/organize/merge" element={<Merge />} />
        <Route path="/organize/split" element={<Split />} />
        <Route path="/organize/rotate" element={<Rotate />} />
        <Route path="/organize/delete-pages" element={<DeletePages />} />
        <Route path="/organize/extract-pages" element={<ExtractPages />} />
        <Route path="/edit/text" element={<TextEdit />} />
        <Route path="/edit/crop" element={<Crop />} />
        <Route path="/edit/watermark" element={<Watermark />} />
        <Route path="/edit/page-numbers" element={<PageNumbers />} />
        <Route path="/mockup/iphone" element={<IphoneMockup />} />
        <Route path="/mockup/web" element={<WebMockup />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  );
}
