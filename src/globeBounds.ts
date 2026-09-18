import {
  _GlobeViewport as GlobeViewport,
  WebMercatorViewport
} from '@deck.gl/core';

export type QueryBounds = [number, number, number, number];

type GlobeViewState = {
  longitude: number;
  latitude: number;
  zoom: number;
};

const LONGITUDE_EPSILON = 1e-9;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function wrapLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function pointIsOnScreen(point: number[], width: number, height: number) {
  return point.every(Number.isFinite)
    && point[0] >= 0
    && point[0] <= width
    && point[1] >= 0
    && point[1] <= height;
}

export function getQueryBoundsForView(
  viewState: GlobeViewState,
  width: number,
  height: number
): QueryBounds[] {
  const viewport = viewState.zoom > 12
    ? new WebMercatorViewport({ ...viewState, width, height })
    : new GlobeViewport({ ...viewState, width, height });

  const [rawWest, rawSouth, rawEast, rawNorth] = viewport.getBounds();
  if (![rawWest, rawSouth, rawEast, rawNorth].every(Number.isFinite)) {
    return [
      [-180, -90, 0, 90],
      [0, -90, 180, 90]
    ];
  }

  const south = clamp(Math.min(rawSouth, rawNorth), -90, 90);
  const north = clamp(Math.max(rawSouth, rawNorth), -90, 90);
  const longitudeSpan = Math.max(0, rawEast - rawWest);

  let containsNorthPole = false;
  let containsSouthPole = false;
  if (viewport instanceof GlobeViewport) {
    const northPole = viewport.project([viewState.longitude, 90]);
    const southPole = viewport.project([viewState.longitude, -90]);
    containsNorthPole = viewState.latitude >= 0 && pointIsOnScreen(northPole, width, height);
    containsSouthPole = viewState.latitude <= 0 && pointIsOnScreen(southPole, width, height);
  }

  const boundedSouth = containsSouthPole ? -90 : south;
  const boundedNorth = containsNorthPole ? 90 : north;

  if (containsNorthPole || containsSouthPole || longitudeSpan >= 360 - LONGITUDE_EPSILON) {
    return [
      [-180, boundedSouth, 0, boundedNorth],
      [0, boundedSouth, 180, boundedNorth]
    ];
  }

  const west = wrapLongitude(rawWest);
  const unwrappedEast = west + longitudeSpan;
  if (unwrappedEast <= 180 + LONGITUDE_EPSILON) {
    return [[west, boundedSouth, Math.min(180, unwrappedEast), boundedNorth]];
  }

  return [
    [west, boundedSouth, 180, boundedNorth],
    [-180, boundedSouth, unwrappedEast - 360, boundedNorth]
  ];
}

export function unwrapPolygon(
  polygon: number[][],
  referenceLongitude: number
): number[][] {
  if (polygon.length === 0) return polygon;

  let previous = polygon[0][0]
    + 360 * Math.round((referenceLongitude - polygon[0][0]) / 360);
  const result = [[previous, polygon[0][1]]];

  for (let index = 1; index < polygon.length; index += 1) {
    const [longitude, latitude] = polygon[index];
    const unwrapped = longitude + 360 * Math.round((previous - longitude) / 360);
    result.push([unwrapped, latitude]);
    previous = unwrapped;
  }

  return result;
}
