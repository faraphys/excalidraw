import {
  Excalidraw,
  LiveCollaborationTrigger,
  CaptureUpdateAction,
  useEditorInterface,
} from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { DEFAULT_CATEGORIES } from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import Trans from "@excalidraw/excalidraw/components/Trans";
import {
  APP_NAME,
  EVENT,
  VERSION_TIMEOUT,
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  isRunningInIframe,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@excalidraw/excalidraw/i18n";

import { ExcalLogo } from "@excalidraw/excalidraw/components/icons";
import { isElementLink } from "@excalidraw/element";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type {
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import {
  Provider,
  useAtom,
  useAtomValue,
  useAtomWithInitialValue,
  appJotaiStore,
} from "./app-jotai";
import {
  FIREBASE_STORAGE_PREFIXES,
  isExcalidrawPlusSignedUser,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import Collab, {
  collabAPIAtom,
  isCollaboratingAtom,
  isOfflineAtom,
} from "./collab/Collab";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import {
  ExportToExcalidrawPlus,
  exportToExcalidrawPlus,
} from "./components/ExportToExcalidrawPlus";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

import { exportToBackend, isCollaborationLink } from "./data";

import { updateStaleImageStatuses } from "./data/FileManager";
import {
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "./data/localStorage";

import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import CollabError, { collabErrorIndicatorAtom } from "./collab/CollabError";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
} from "./components/DebugCanvas";
import { AIComponents } from "./components/AI";
import { ExcalidrawPlusIframeExport } from "./ExcalidrawPlusIframeExport";

import "./index.scss";

import { ExcalidrawPlusPromoBanner } from "./components/ExcalidrawPlusPromoBanner";
import { AppSidebar } from "./components/AppSidebar";

import type { CollabAPI } from "./collab/Collab";

import { useCallbackRefState } from "@excalidraw/excalidraw/hooks/useCallbackRefState";
import { shareDialogStateAtom } from "./share/ShareDialog";

polyfill();
window.EXCALIDRAW_THROTTLE_RENDER = true;

declare global {
  interface BeforeInstallPromptEventChoiceResult {
    outcome: "accepted" | "dismissed";
  }

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<BeforeInstallPromptEventChoiceResult>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let pwaEvent: BeforeInstallPromptEvent | null = null;
window.addEventListener(
  "beforeinstallprompt",
  (event: BeforeInstallPromptEvent) => {
    event.preventDefault();
    pwaEvent = event;
  },
);

// --------------------
// Scope + transparency
// --------------------
const getScopeKey = () => {
  try {
    return new URLSearchParams(window.location.search).get("scope") || "default";
  } catch {
    return "default";
  }
};

const TRANSPARENT_BG = "rgba(0,0,0,0)";

// IMPORTANT: Build a *full* AppState base.
// - If API exists: use excalidrawAPI.getAppState() (contains width/height/offsets).
// - Else: synthesize a safe base with required fields.
const getBaseAppState = (api: ExcalidrawImperativeAPI | null): AppState => {
  if (api) return api.getAppState();

  const d: any = getDefaultAppState();
  return {
    ...(d as AppState),
    width: typeof d.width === "number" ? d.width : 0,
    height: typeof d.height === "number" ? d.height : 0,
    offsetTop: typeof d.offsetTop === "number" ? d.offsetTop : 0,
    offsetLeft: typeof d.offsetLeft === "number" ? d.offsetLeft : 0,
  };
};

// --------------------
// Defaults you want at startup (and after restore)
// --------------------
const DEFAULT_APPSTATE_OVERRIDES: Partial<AppState> = {
  isLoading: false,
  openDialog: null,
  viewBackgroundColor: TRANSPARENT_BG,

  // “small palette” behavior is often tied to penMode
  penMode: true,

  // Start-Tool: Pen/Freedraw + tool lock ON
  activeTool: {
    type: "freedraw",
    customType: null,
    locked: true,
    lastActiveTool: null,
    fromSelection: false,
  } as any,

  // Defaults:
  // - roughness: Architect (0)
  // - strokeWidth: thin (1)
  // - arrowheads: filled triangle on end
  currentItemRoughness: 0,
  currentItemStrokeWidth: 1,
  currentItemEndArrowhead: "triangle" as any,
  currentItemStartArrowhead: null as any,
};

// Apply defaults WITHOUT wiping stored elements.
// We do this once when API becomes available, and also after restore-syncs.
const applyStartupDefaults = (api: ExcalidrawImperativeAPI) => {
  const base = getBaseAppState(api);
  api.updateScene({
    appState: {
      ...base,
      ...DEFAULT_APPSTATE_OVERRIDES,
    } as AppState,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

// --------------------
// initializeScene: load only scoped local storage
// --------------------
const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const scope = getScopeKey();
  const localDataState = importFromLocalStorage(scope);

  const restoredElements = restoreElements(localDataState?.elements, null, {
    repairBindings: true,
    deleteInvisibleElements: true,
  });

  // restoreAppState gives us partial-ish; we merge later with base from api
  const restoredFromStorage = restoreAppState(localDataState?.appState, null);

  return {
    scene: {
      elements: restoredElements,
      appState: {
        ...restoredFromStorage,
        // make sure loader/dialog don’t appear even before we apply defaults
        isLoading: false,
        openDialog: null,
        viewBackgroundColor: TRANSPARENT_BG,
      } as any,
    },
    isExternalScene: false,
  };
};

const ExcalidrawWrapper = () => {
  const isCollabDisabled = isRunningInIframe();

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();
  const [langCode, setLangCode] = useAppLangCode();
  const editorInterface = useEditorInterface();

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const [debugAppState, setDebugAppState] = useState<AppState | null>(null);

  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();

  const forcingTransparentBgRef = useRef(false);

  // Keep bg transparent + no loader even if something restores a color.
  useEffect(() => {
    if (!excalidrawAPI) return;

    // Apply startup defaults once API is ready
    applyStartupDefaults(excalidrawAPI);

    forcingTransparentBgRef.current = true;
    excalidrawAPI.updateScene({
      appState: { viewBackgroundColor: TRANSPARENT_BG, isLoading: false } as any,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    queueMicrotask(() => {
      forcingTransparentBgRef.current = false;
    });
  }, [excalidrawAPI]);

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [, setShareDialogState] = useAtom(shareDialogStateAtom);
  const [collabAPI] = useAtom(collabAPIAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });
  const collabError = useAtomValue(collabErrorIndicatorAtom);
  const isOffline = useAtomValue(isOfflineAtom);
  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI?.setToast?.({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    if (exportedElements.length === 0) {
      throw new Error(t("alerts.cannotExportEmptyCanvas"));
    }
    const { url, errorMessage } = await exportToBackend(
      exportedElements,
      {
        ...appState,
        exportBackground: appState.exportBackground,
        viewBackgroundColor: TRANSPARENT_BG,
      },
      files,
    );

    if (errorMessage) throw new Error(errorMessage);

    if (url) {
      excalidrawAPI?.setToast?.({ message: url });
    }
  };

  const onCollabDialogOpen = useCallback(() => {
    setShareDialogState({ isOpen: true, type: "share" });
  }, [setShareDialogState]);

  const showPlusIframeExport =
    isRunningInIframe() &&
    new URLSearchParams(window.location.search).has("plus_iframe_export");
  if (showPlusIframeExport) {
    return <ExcalidrawPlusIframeExport />;
  }

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (isVisualDebuggerEnabled()) {
      setDebugAppState(appState);
    }

    // Force transparent background.
    if (forcingTransparentBgRef.current) {
      forcingTransparentBgRef.current = false;
    } else if (
      excalidrawAPI &&
      appState.viewBackgroundColor !== TRANSPARENT_BG
    ) {
      forcingTransparentBgRef.current = true;
      excalidrawAPI.updateScene({
        appState: { viewBackgroundColor: TRANSPARENT_BG, isLoading: false } as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }

    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (!excalidrawAPI) return;

        let didChange = false;

        const nextElements = excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .map((element) => {
            if (LocalData.fileStorage.shouldUpdateImageElementStatus(element)) {
              const newElement = newElementWith(element, { status: "saved" });
              if (newElement !== element) didChange = true;
              return newElement;
            }
            return element;
          });

        if (didChange) {
          excalidrawAPI.updateScene({
            elements: nextElements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      });
    }

    if (debugCanvasRef.current && excalidrawAPI) {
      debugRenderer(
        debugCanvasRef.current,
        appState,
        elements,
        window.devicePixelRatio,
      );
    }
  };

  useEffect(() => {
    if (!excalidrawAPI || (!isCollabDisabled && !collabAPI)) {
      return;
    }

    const loadImages = async (
      data: ResolutionType<typeof initializeScene>,
      isInitialLoad = false,
    ) => {
      if (!data.scene || !isInitialLoad) return;

      const sceneElements = data.scene.elements ?? [];
      const currFiles: BinaryFiles = excalidrawAPI.getFiles();

      const fileIds = sceneElements.reduce<FileId[]>((acc, el) => {
        if (isInitializedImageElement(el) && !currFiles[el.fileId]) {
          acc.push(el.fileId);
        }
        return acc;
      }, []);

      if (!fileIds.length) return;

      const { loadedFiles, erroredFiles } = await LocalData.fileStorage.getFiles(
        fileIds,
      );

      if (loadedFiles.length) {
        excalidrawAPI.addFiles(loadedFiles);
      }

      updateStaleImageStatuses({
        excalidrawAPI,
        erroredFiles,
        elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

      LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds });
    };

    // Initial load: resolve initialData exactly once.
    initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
      await loadImages(data, true);

      const base = getBaseAppState(excalidrawAPI);

      if (data.scene) {
        initialStatePromiseRef.current.promise.resolve({
          ...data.scene,
          appState: {
            ...base,
            ...(data.scene.appState as any),
            ...DEFAULT_APPSTATE_OVERRIDES, // IMPORTANT: defaults LAST (override storage)
          } as AppState,
        });

        // Also enforce on live state (in case Excalidraw internally normalizes)
        applyStartupDefaults(excalidrawAPI);
      } else {
        initialStatePromiseRef.current.promise.resolve({
          elements: [],
          appState: {
            ...base,
            ...DEFAULT_APPSTATE_OVERRIDES,
          } as AppState,
        });
        applyStartupDefaults(excalidrawAPI);
      }
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();

      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (libraryUrlTokens) return;

      if (
        collabAPI?.isCollaborating() &&
        !isCollaborationLink(window.location.href)
      ) {
        collabAPI.stopCollaboration(false);
      }

      const data = await initializeScene({ collabAPI, excalidrawAPI });
      await loadImages(data, true);

      const base = getBaseAppState(excalidrawAPI);

      if (data.scene) {
        excalidrawAPI.updateScene({
          elements: restoreElements(data.scene.elements, null, {
            repairBindings: true,
          }),
          appState: {
            ...base,
            ...restoreAppState((data.scene.appState as any) ?? null, base),
            ...DEFAULT_APPSTATE_OVERRIDES,
          } as AppState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      } else {
        excalidrawAPI.updateScene({
          elements: [],
          appState: {
            ...base,
            ...DEFAULT_APPSTATE_OVERRIDES,
          } as AppState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    };

    const syncData = debounce(() => {
      if (isTestEnv()) return;

      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const scope = getScopeKey();
          const localDataState = importFromLocalStorage(scope);
          const username = importUsernameFromLocalStorage(scope);

          setLangCode(getPreferredLanguage());

          const base = getBaseAppState(excalidrawAPI);

          excalidrawAPI.updateScene({
            elements: restoreElements(localDataState?.elements, null, {
              repairBindings: true,
            }),
            appState: {
              ...base,
              ...restoreAppState(localDataState?.appState, base),
              ...DEFAULT_APPSTATE_OVERRIDES,
            } as AppState,
            captureUpdate: CaptureUpdateAction.NEVER,
          });

          LibraryIndexedDBAdapter.load().then((data) => {
            if (data) {
              excalidrawAPI.updateLibrary({
                libraryItems: data.libraryItems,
              });
            }
          });

          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles: BinaryFiles = excalidrawAPI.getFiles();

          const fileIds = sceneElements.reduce<FileId[]>((acc, el) => {
            if (isInitializedImageElement(el) && !currFiles[el.fileId]) {
              acc.push(el.fileId);
            }
            return acc;
          }, []);

          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    window.addEventListener(EVENT.HASHCHANGE, onHashChange);
    window.addEventListener(EVENT.VISIBILITY_CHANGE, syncData);

    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange);
      window.removeEventListener(EVENT.VISIBILITY_CHANGE, syncData);
    };
  }, [collabAPI, excalidrawAPI, isCollabDisabled, setLangCode]);

  useEffect(() => {
    if (!excalidrawAPI) return;

    const unloadHandler = (event: BeforeUnloadEvent) => {
      if (
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        }
      }
    };

    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  const showCollabDialog =
    isCollaborating &&
    !collabError.message &&
    collabAPI &&
    !isCollabDisabled &&
    excalidrawAPI;

  return (
    <div
      style={{ height: "95vh", overflow: "hidden" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
        "is-offline": isOffline,
      })}
    >
      <Excalidraw
        excalidrawAPI={excalidrawRefCallback}
        onChange={onChange}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              onExportToBackend,
              renderCustomUI: excalidrawAPI
                ? (elements, appState, files) => (
                    <ExportToExcalidrawPlus
                      elements={elements}
                      appState={appState}
                      files={files}
                      name={excalidrawAPI.getName()}
                      onError={(error) => {
                        excalidrawAPI?.updateScene({
                          appState: {
                            errorMessage: error.message,
                            isLoading: false,
                          } as any,
                        });
                      }}
                      onSuccess={() => {
                        excalidrawAPI.updateScene({
                          appState: { openDialog: null, isLoading: false } as any,
                        });
                      }}
                    />
                  )
                : undefined,
            },
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        renderTopRightUI={(isMobile) => {
          if (isMobile || !collabAPI || isCollabDisabled) {
            return null;
          }

          return (
            <div className="excalidraw-ui-top-right">
              {excalidrawAPI?.getEditorInterface().formFactor === "desktop" && (
                <ExcalidrawPlusPromoBanner
                  isSignedIn={isExcalidrawPlusSignedUser}
                />
              )}

              {collabError.message && <CollabError collabError={collabError} />}
              <LiveCollaborationTrigger
                isCollaborating={isCollaborating}
                onSelect={() =>
                  setShareDialogState({ isOpen: true, type: "share" })
                }
                editorInterface={editorInterface}
              />
            </div>
          );
        }}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.scrollToContent(element.link, { animate: true });
          }
        }}
      >
        <AppMainMenu
          onCollabDialogOpen={onCollabDialogOpen}
          isCollaborating={isCollaborating}
          isCollabEnabled={!isCollabDisabled}
          theme={appTheme}
          setTheme={(theme) => setAppTheme(theme)}
          refresh={() => excalidrawAPI?.refresh()}
        />

        <AppWelcomeScreen
          onCollabDialogOpen={onCollabDialogOpen}
          isCollabEnabled={!isCollabDisabled}
        />

        {localStorageQuotaExceeded && (
          <ErrorDialog onClose={() => {}}>
            Local storage is full — can’t save. Please free up browser storage or
            disable autosave.
          </ErrorDialog>
        )}

        {showCollabDialog && <Collab excalidrawAPI={excalidrawAPI} />}

        {excalidrawAPI ? <AIComponents excalidrawAPI={excalidrawAPI} /> : null}

        {isVisualDebuggerEnabled() && debugAppState && (
          <DebugCanvas
            ref={debugCanvasRef}
            appState={debugAppState}
            scale={window.devicePixelRatio}
          />
        )}

        <AppSidebar />

        <AppFooter onChange={() => excalidrawAPI?.refresh()} />

        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
          {excalidrawAPI && (
            <OverwriteConfirmDialog.Action
              title={t("overwriteConfirm.action.excalidrawPlus.title")}
              actionLabel={t("overwriteConfirm.action.excalidrawPlus.button")}
              onClick={() => {
                exportToExcalidrawPlus(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                  excalidrawAPI.getName(),
                );
              }}
            >
              {t("overwriteConfirm.action.excalidrawPlus.description")}
            </OverwriteConfirmDialog.Action>
          )}
        </OverwriteConfirmDialog>
      </Excalidraw>
    </div>
  );
};

const App = () => (
  <TopErrorBoundary>
    <Provider store={appJotaiStore}>
      <ExcalidrawWrapper />
    </Provider>
  </TopErrorBoundary>
);

export default App;