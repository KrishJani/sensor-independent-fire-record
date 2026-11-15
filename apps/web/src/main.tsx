import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './styles.css';
import { App } from './App';
import { MissingToken } from './components/MissingToken';

const token = import.meta.env.VITE_MAPBOX_TOKEN;
if (token) mapboxgl.accessToken = token;

createRoot(document.getElementById('root')!).render(
  <StrictMode>{token ? <App /> : <MissingToken />}</StrictMode>,
);
