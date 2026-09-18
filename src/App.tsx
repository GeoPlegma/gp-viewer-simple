// Copyright 2026 contributors to the GeoPlegmata project.
// Originally authored by Francisco Salgueiro, Instituto Superior Técnico (francisco.salgueiro@tecnico.ulisboa.pt)
//
// Licenced under the Apache Licence, Version 2.0 <LICENCE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENCE-MIT or http://opensource.org/licenses/MIT>, at your
// discretion. This file may not be copied, modified, or distributed
// except according to those terms.

import { useState, useMemo, useEffect, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView } from '@deck.gl/core';
import { SolidPolygonLayer, GeoJsonLayer } from '@deck.gl/layers';

import { invoke } from '@tauri-apps/api/core';
import './App.css';
import { getQueryBoundsForView, unwrapPolygon } from './globeBounds';

const BAND_KEY_PREFIX = 'band_';

function asUint8Array(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  if (Array.isArray(payload)) {
    return Uint8Array.from(payload);
  }
  throw new Error('Unexpected binary payload from backend');
}

function decodeBinary(payload: unknown) {
  const bytes = asUint8Array(payload);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const bandCount = view.getUint32(offset, true);
  offset += 4;
  const cellCount = view.getUint32(offset, true);
  offset += 4;

  const cells = new Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    const vertexCount = view.getUint16(offset, true);
    offset += 2;
    const polygon = new Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const lon = view.getFloat64(offset, true);
      offset += 8;
      const lat = view.getFloat64(offset, true);
      offset += 8;
      polygon[v] = [lon, lat];
    }
    const cell: Record<string, any> = { polygon };

    for (let band = 0; band < bandCount; band += 1) {
      const value = view.getFloat64(offset, true);
      offset += 8;
      if (Number.isFinite(value)) {
        cell[`${BAND_KEY_PREFIX}${band}`] = value;
      }
    }

    cells[index] = cell;
  }

  return { bandCount, cells };
}

const COUNTRIES_BORDERS_URL = '/countries.geojson';




const earthMaskLayer = new GeoJsonLayer({
  id: 'EarthMaskLayer',
  data: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-180, -90],
            [-180, 90],
            [180, 90],
            [180, -90],
            [-180, -90]
          ]]
        }
      }
    ]
  },
  stroked: false,
  filled: true,
  getFillColor: [255, 255, 255, 255],
  pickable: false
});

const countriesBordersLayer = new GeoJsonLayer({
  id: 'CountriesBordersLayer',
  data: COUNTRIES_BORDERS_URL,
  stroked: true,
  filled: false,
  lineWidthMinPixels: 1,
  getLineColor: [120, 132, 145, 120],
  pickable: false
});

function getVectorCenter(data: any): [number, number] | null {
  if (!data) return null;
  const features = data.features || (data.type === 'Feature' ? [data] : []);
  if (!features || features.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;

  function traverseCoords(coords: any) {
    if (Array.isArray(coords)) {
      if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        sumLon += coords[0];
        sumLat += coords[1];
        count += 1;
      } else {
        coords.forEach(traverseCoords);
      }
    }
  }

  for (const f of features) {
    if (f && f.geometry && f.geometry.coordinates) {
      traverseCoords(f.geometry.coordinates);
    }
  }

  if (count > 0) {
    return [sumLon / count, sumLat / count];
  }
  return null;
}

function App() {
  const [inputPath, setInputPath] = useState('./tmp/gp_encoding_convert');
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mode, setMode] = useState<'vector' | 'raster' | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [level, setLevel] = useState<number | null>(null);
  const [cells, setCells] = useState<any[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const [bandCount, setBandCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 0,
    zoom: 1,
    maxZoom: 20,
    pitch: 30,
    bearing: 0
  });
  const [error, setError] = useState<string | null>(null);

  const [vectorData, setVectorData] = useState<any>(null);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);

  const resolveDefaultLevel = (availableLevels: number[]) => {
    if (availableLevels.length === 0) {
      return null;
    }
    const sortedLevels = [...availableLevels].sort((a, b) => a - b);
    return sortedLevels[sortedLevels.length - 1];
  };

  const handleLoadFile = async () => {
    if (!inputPath) return;
    setIsLoading(true);
    setError(null);
    try {
      const fileType = await invoke<string>('check_file_type', { path: inputPath });
      
      if (fileType === 'vector') {
        setMode('vector');
        setActivePath(inputPath);
        
        const data: any = await invoke('load_vector_geojson', { path: inputPath });
        setVectorData(data);
        let targetGeojson = data;
        if (data.layers) {
          const layerNames = Object.keys(data.layers);
          if (layerNames.length > 0) {
            setSelectedLayer(layerNames[0]);
            targetGeojson = data.layers[layerNames[0]];
          } else {
            setSelectedLayer(null);
          }
        } else {
          setSelectedLayer(null);
        }

        const center = getVectorCenter(targetGeojson);
        if (center) {
          setViewState(prev => ({
            ...prev,
            longitude: center[0],
            latitude: center[1],
            zoom: Math.max(prev.zoom, 5)
          }));
        }
      } else if (fileType === 'raster') {
        setMode('raster');
        setActivePath(inputPath);
        
        const storeLevels: number[] = await invoke('get_levels', { store: inputPath });
        const sortedLevels = [...storeLevels].sort((a, b) => a - b);
        setLevels(sortedLevels);
        setLevel((current) => {
          if (current !== null && sortedLevels.includes(current)) {
            return current;
          }
          return resolveDefaultLevel(sortedLevels);
        });
      }
    } catch (err: any) {
      console.error(err);
      setError(err.toString());
      setMode(null);
      setActivePath(null);
    } finally {
      setIsLoading(false);
    }
  };

  const resolveLevelForZoom = (zoom: number, availableLevels: number[]) => {
    if (availableLevels.length === 0) return null;
    const target = Math.max(0, Math.floor(zoom));
    let best = availableLevels[0];
    for (const lvl of availableLevels) {
      if (lvl <= target) {
        best = lvl;
      }
    }
    return best;
  };

  const loadDataForCurrentView = async () => {
    if (levels.length === 0 || !activePath) return;
    const requestId = ++requestIdRef.current;
    setError(null);
    setIsLoading(true);
    try {
      const resolvedLevel = resolveLevelForZoom(viewState.zoom, levels);
      if (resolvedLevel === null) {
        throw new Error('No levels found in the selected store');
      }

      const width = window.innerWidth;
      const height = window.innerHeight;
      const visibleBounds = getQueryBoundsForView(viewState, width, height);
      const queryBounds = resolvedLevel <= 2 ? visibleBounds.slice(0, 1) : visibleBounds;
      const payloads = await Promise.all(queryBounds.map(bbox => invoke('get_data_binary', {
        store: activePath,
        level: resolvedLevel,
        bbox
      })));

      if (requestId !== requestIdRef.current) return;

      const decoded = payloads.map(decodeBinary);
      const decodedBandCount = decoded[0]?.bandCount ?? 0;
      if (decoded.some(result => result.bandCount !== decodedBandCount)) {
        throw new Error('Inconsistent band count between viewport queries');
      }

      const uniqueCells = new Map<string, any>();
      for (const result of decoded) {
        for (const cell of result.cells) {
          uniqueCells.set(JSON.stringify(cell.polygon), cell);
        }
      }
      setCells([...uniqueCells.values()]);
      setBandCount(decodedBandCount);
      setLevel(resolvedLevel);
    } catch (err: any) {
      if (requestId === requestIdRef.current) {
        console.error(err);
        setError(err.toString());
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    requestIdRef.current += 1;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (mode === 'raster' && activePath && levels.length > 0) {
      timeoutRef.current = window.setTimeout(() => {
        loadDataForCurrentView();
      }, 500);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [viewState, levels, activePath, mode]);



  const layers = useMemo(() => {
    const layerList: any[] = [countriesBordersLayer, earthMaskLayer];

    if (mode === 'raster' && cells.length > 0) {
      const useElevation = bandCount === 1;

      const polygonLayer = new SolidPolygonLayer({
        id: 'SolidPolygonLayer',
        data: cells,
        elevationScale: 20,
        extruded: useElevation,
        filled: true,
        getElevation: useElevation ? (d: any) => d.band_0 / 2 : 0,
        getFillColor: useElevation
          ? (d: any) => [d.band_0, d.band_0, d.band_0]
          : (d: any) => [d.band_0, d.band_1, d.band_2],
        getPolygon: (d: any) => unwrapPolygon(d.polygon, viewState.longitude),
        wireframe: false,
        pickable: true,
      });

      layerList.push(polygonLayer);
    } else if (mode === 'vector' && vectorData) {
      let geojsonToRender = null;
      if (vectorData.geojson) {
        geojsonToRender = vectorData.geojson;
      } else if (vectorData.layers && selectedLayer && vectorData.layers[selectedLayer]) {
        geojsonToRender = vectorData.layers[selectedLayer];
      } else if (vectorData.type === 'FeatureCollection' || vectorData.type === 'Feature' || vectorData.features) {
        geojsonToRender = vectorData;
      }

      if (geojsonToRender) {
        const vectorLayer = new GeoJsonLayer({
          id: 'VectorGeoJsonLayer',
          data: geojsonToRender,
          stroked: true,
          filled: true,
          pointRadiusMinPixels: 6,
          lineWidthMinPixels: 2,
          getFillColor: [34, 211, 238, 160],
          getLineColor: [34, 211, 238, 255],
          getPointRadius: 100,
          getElevation: 0,
          pickable: true,
        });
        layerList.push(vectorLayer);
      }
    }

    return layerList;
  }, [cells, bandCount, mode, vectorData, selectedLayer, viewState.longitude]);

  return (
    <div className="app-root" onContextMenu={(e) => e.preventDefault()}>
      <DeckGL
        views={new GlobeView({ id: 'globe' })}
        initialViewState={viewState}
        onViewStateChange={({ viewState }: any) => setViewState(viewState as any)}
        controller={true}
        layers={layers}
        getTooltip={({ object }: any) => {
          if (!object) return null;
          if (object.hex) return object.hex;
          if (object.properties) {
            return Object.entries(object.properties)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n');
          }
          return null;
        }}
        style={{ backgroundColor: 'transparent' }}
      />

      <div className="app-shell">
        <div className="shell-middle">
          <aside className="control-panel">
            <div className="input-group">
              <label>Data Path</label>
              <input
                type="text"
                value={inputPath}
                onChange={e => setInputPath(e.target.value)}
                placeholder="/path/to/zarr or /path/to/vector.json"
              />
            </div>
            
            <div className="panel-actions">
              <button onClick={handleLoadFile} disabled={isLoading || !inputPath}>
                {isLoading ? 'Loading...' : 'Load File'}
              </button>
            </div>

            {mode === 'raster' && (
              <>
                <div className="input-group">
                  <label>Active Level</label>
                  <input
                    type="text"
                    value={level !== null ? level : ''}
                    disabled
                  />
                </div>
                <div className="panel-actions">
                  <button onClick={loadDataForCurrentView} disabled={isLoading || levels.length === 0}>
                    {isLoading ? 'Loading...' : 'Reload Data'}
                  </button>
                </div>
              </>
            )}
            
            {mode === 'vector' && (
              <>
                {vectorData && (
                  <>
                    <div className="input-group">
                      <label>DGGRS</label>
                      <input
                        type="text"
                        value={vectorData.dggrs}
                        disabled
                      />
                    </div>
                    <div className="input-group">
                      <label>Refinement Level</label>
                      <input
                        type="text"
                        value={vectorData.refinement_level}
                        disabled
                      />
                    </div>
                  </>
                )}
                {vectorData && vectorData.layers && (
                  <div className="input-group">
                    <label>Selected Layer</label>
                    <select
                      value={selectedLayer || ''}
                      onChange={e => {
                        const nextLayer = e.target.value;
                        setSelectedLayer(nextLayer);
                        if (vectorData?.layers?.[nextLayer]) {
                          const center = getVectorCenter(vectorData.layers[nextLayer]);
                          if (center) {
                            setViewState(prev => ({
                              ...prev,
                              longitude: center[0],
                              latitude: center[1],
                            }));
                          }
                        }
                      }}
                    >
                      {Object.keys(vectorData.layers).map(name => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}

            {error && <div className="error">{error}</div>}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default App;
