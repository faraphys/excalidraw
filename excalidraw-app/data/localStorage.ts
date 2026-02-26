import {
  clearAppStateForLocalStorage,
  getDefaultAppState,
} from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

// ------------------------------
// Scoping helpers
// ------------------------------
// Prefix localStorage keys by scope so multiple embeds don't collide.
// Example: scope="slide-12" -> "slide-12::excalidraw-elements"
const scopeKey = (key: string, scope?: string | null) => {
  const s = (scope || "").trim();
  return s ? `${s}::${key}` : key;
};

export const saveUsernameToLocalStorage = (username: string, scope?: string) => {
  try {
    localStorage.setItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_COLLAB, scope),
      JSON.stringify({ username }),
    );
  } catch (error: any) {
    // Unable to access window.localStorage
    console.error(error);
  }
};

export const importUsernameFromLocalStorage = (scope?: string): string | null => {
  try {
    const data = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_COLLAB, scope),
    );
    if (data) {
      return JSON.parse(data).username;
    }
  } catch (error: any) {
    // Unable to access localStorage
    console.error(error);
  }

  return null;
};

export const importFromLocalStorage = (scope?: string) => {
  let savedElements: string | null = null;
  let savedState: string | null = null;

  try {
    savedElements = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, scope),
    );
    savedState = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, scope),
    );
  } catch (error: any) {
    // Unable to access localStorage
    console.error(error);
  }

  let elements: ExcalidrawElement[] = [];
  if (savedElements) {
    try {
      elements = JSON.parse(savedElements);
    } catch (error: any) {
      console.error(error);
      // Do nothing because elements array is already empty
    }
  }

  let appState: Partial<AppState> | null = null;
  if (savedState) {
    try {
      appState = {
        ...getDefaultAppState(),
        ...clearAppStateForLocalStorage(
          JSON.parse(savedState) as Partial<AppState>,
        ),
      };
    } catch (error: any) {
      console.error(error);
      // Do nothing because appState is already null
    }
  }

  return { elements, appState };
};

export const getElementsStorageSize = (scope?: string) => {
  try {
    const elements = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, scope),
    );
    return elements?.length || 0;
  } catch (error: any) {
    console.error(error);
    return 0;
  }
};

export const getTotalStorageSize = (scope?: string) => {
  try {
    const appState = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, scope),
    );
    const collab = localStorage.getItem(
      scopeKey(STORAGE_KEYS.LOCAL_STORAGE_COLLAB, scope),
    );

    const appStateSize = appState?.length || 0;
    const collabSize = collab?.length || 0;

    return appStateSize + collabSize + getElementsStorageSize(scope);
  } catch (error: any) {
    console.error(error);
    return 0;
  }
};