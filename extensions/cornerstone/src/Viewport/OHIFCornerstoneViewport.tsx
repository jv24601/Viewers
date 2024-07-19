import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useResizeDetector } from 'react-resize-detector';
import PropTypes from 'prop-types';
import * as cs3DTools from '@cornerstonejs/tools';
import {
  Enums,
  eventTarget,
  getEnabledElement,
  StackViewport,
  utilities as csUtils,
} from '@cornerstonejs/core';
import { MeasurementService } from '@ohif/core';
import { Notification, useViewportDialog, AllInOneMenu } from '@ohif/ui';
import { IStackViewport, IVolumeViewport } from '@cornerstonejs/core/dist/esm/types';

import { setEnabledElement } from '../state';

import './OHIFCornerstoneViewport.css';
import CornerstoneOverlays from './Overlays/CornerstoneOverlays';
import getSOPInstanceAttributes from '../utils/measurementServiceMappings/utils/getSOPInstanceAttributes';
import CinePlayer from '../components/CinePlayer';
import { Types } from '@ohif/core';

import OHIFViewportActionCorners from '../components/OHIFViewportActionCorners';
import { getWindowLevelActionMenu } from '../components/WindowLevelActionMenu/getWindowLevelActionMenu';
import { useAppConfig } from '@state';

import { LutPresentation, PositionPresentation } from '../types/Presentation';

import { LineChart } from '@ohif/ui';
import { cache } from '@cornerstonejs/core';
import { isAxisAlignedRectangle } from '@cornerstonejs/tools/dist/types/utilities/rectangleROITool';

const STACK = 'stack';

/**
 * Caches the jump to measurement operation, so that if display set is shown,
 * it can jump to the measurement.
 */
let cacheJumpToMeasurementEvent;

function areEqual(prevProps, nextProps) {
  if (nextProps.needsRerendering) {
    return false;
  }

  if (prevProps.displaySets.length !== nextProps.displaySets.length) {
    return false;
  }

  if (prevProps.viewportOptions.orientation !== nextProps.viewportOptions.orientation) {
    return false;
  }

  if (prevProps.viewportOptions.toolGroupId !== nextProps.viewportOptions.toolGroupId) {
    return false;
  }

  if (prevProps.viewportOptions.viewportType !== nextProps.viewportOptions.viewportType) {
    return false;
  }

  if (nextProps.viewportOptions.needsRerendering) {
    return false;
  }

  const prevDisplaySets = prevProps.displaySets;
  const nextDisplaySets = nextProps.displaySets;

  if (prevDisplaySets.length !== nextDisplaySets.length) {
    return false;
  }

  for (let i = 0; i < prevDisplaySets.length; i++) {
    const prevDisplaySet = prevDisplaySets[i];

    const foundDisplaySet = nextDisplaySets.find(
      nextDisplaySet =>
        nextDisplaySet.displaySetInstanceUID === prevDisplaySet.displaySetInstanceUID
    );

    if (!foundDisplaySet) {
      return false;
    }

    // check they contain the same image
    if (foundDisplaySet.images?.length !== prevDisplaySet.images?.length) {
      return false;
    }

    // check if their imageIds are the same
    if (foundDisplaySet.images?.length) {
      for (let j = 0; j < foundDisplaySet.images.length; j++) {
        if (foundDisplaySet.images[j].imageId !== prevDisplaySet.images[j].imageId) {
          return false;
        }
      }
    }
  }

  return true;
}

// Todo: This should be done with expose of internal API similar to react-vtkjs-viewport
// Then we don't need to worry about the re-renders if the props change.
const OHIFCornerstoneViewport = React.memo((props: withAppTypes) => {
  const {
    displaySets,
    dataSource,
    viewportOptions,
    displaySetOptions,
    servicesManager,
    onElementEnabled,
    // eslint-disable-next-line react/prop-types
    onElementDisabled,
    isJumpToMeasurementDisabled = false,
    // Note: you SHOULD NOT use the initialImageIdOrIndex for manipulation
    // of the imageData in the OHIFCornerstoneViewport. This prop is used
    // to set the initial state of the viewport's first image to render
    // eslint-disable-next-line react/prop-types
    initialImageIndex,
    // if the viewport is part of a hanging protocol layout
    // we should not really rely on the old synchronizers and
    // you see below we only rehydrate the synchronizers if the viewport
    // is not part of the hanging protocol layout. HPs should
    // define their own synchronizers. Since the synchronizers are
    // viewportId dependent and
    // eslint-disable-next-line react/prop-types
    isHangingProtocolLayout,
  } = props;

  const viewportId = viewportOptions.viewportId;

  if (!viewportId) {
    throw new Error('Viewport ID is required');
  }

  // Since we only have support for dynamic data in volume viewports, we should
  // handle this case here and set the viewportType to volume if any of the
  // displaySets are dynamic volumes
  viewportOptions.viewportType = displaySets.some(ds => ds.isDynamicVolume && ds.isReconstructable)
    ? 'volume'
    : viewportOptions.viewportType;

  const [scrollbarHeight, setScrollbarHeight] = useState('100px');
  const [enabledVPElement, setEnabledVPElement] = useState(null);
  const elementRef = useRef() as React.MutableRefObject<HTMLDivElement>;
  const [appConfig] = useAppConfig();

  const {
    measurementService,
    displaySetService,
    toolbarService,
    toolGroupService,
    syncGroupService,
    cornerstoneViewportService,
    cornerstoneCacheService,
    viewportGridService,
    stateSyncService,
    viewportActionCornersService,
  } = servicesManager.services;

  const [viewportDialogState] = useViewportDialog();
  // useCallback for scroll bar height calculation
  const setImageScrollBarHeight = useCallback(() => {
    const scrollbarHeight = `${elementRef.current.clientHeight - 40}px`;
    setScrollbarHeight(scrollbarHeight);
  }, [elementRef]);

  // useCallback for onResize
  const onResize = useCallback(() => {
    if (elementRef.current) {
      cornerstoneViewportService.resize();
      setImageScrollBarHeight();
    }
  }, [elementRef]);

  // the official React documents advise using state when parents should react to child component data changes
  const [doesGraphNeedUpdate, setDoesGraphNeedUpdate] = useState(false);

  // a callback to pass to the child
  const makeGraphUpdateCallback = useCallback(() => {
    setDoesGraphNeedUpdate(true);
  }, [setDoesGraphNeedUpdate]);

  if (doesGraphNeedUpdate) {
    setDoesGraphNeedUpdate(false);
  }

  // define constants to get the current slice
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const currentImageSlice = viewport?.getSliceIndex();
  const currentImageId = _getCurrentFrameImageId(displaySets, currentImageSlice);

  // a helper to get points for the graph, mock values.
  // the values of the actual graph data should be fetched asyncronously and cached for performance
  const points = _getPointsForGraph(currentImageId);
  const axis = {
    x: { label: 'Pixel index', indexRef: 0, type: 'x', range: { min: 0, max: 1 } },
    y: { label: 'Pixel value', indexRef: 1, type: 'y', range: { min: 0, max: 1 } },
  };
  const series = [{ points: points }];

  const cleanUpServices = useCallback(
    viewportInfo => {
      const renderingEngineId = viewportInfo.getRenderingEngineId();
      const syncGroups = viewportInfo.getSyncGroups();

      toolGroupService.removeViewportFromToolGroup(viewportId, renderingEngineId);

      syncGroupService.removeViewportFromSyncGroup(viewportId, renderingEngineId, syncGroups);

      viewportActionCornersService.clear(viewportId);
    },
    [viewportId]
  );

  const elementEnabledHandler = useCallback(
    evt => {
      // check this is this element reference and return early if doesn't match
      if (evt.detail.element !== elementRef.current) {
        return;
      }

      const { viewportId, element } = evt.detail;
      const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
      setEnabledElement(viewportId, element);
      setEnabledVPElement(element);

      const renderingEngineId = viewportInfo.getRenderingEngineId();
      const toolGroupId = viewportInfo.getToolGroupId();
      const syncGroups = viewportInfo.getSyncGroups();

      toolGroupService.addViewportToToolGroup(viewportId, renderingEngineId, toolGroupId);

      syncGroupService.addViewportToSyncGroup(viewportId, renderingEngineId, syncGroups);

      const synchronizersStore = stateSyncService.getState().synchronizersStore;

      if (synchronizersStore?.[viewportId]?.length && !isHangingProtocolLayout) {
        // If the viewport used to have a synchronizer, re apply it again
        _rehydrateSynchronizers(synchronizersStore, viewportId, syncGroupService);
      }

      if (onElementEnabled) {
        onElementEnabled(evt);
      }
    },
    [viewportId, onElementEnabled, toolGroupService]
  );

  // disable the element upon unmounting
  useEffect(() => {
    cornerstoneViewportService.enableViewport(viewportId, elementRef.current);

    eventTarget.addEventListener(Enums.Events.ELEMENT_ENABLED, elementEnabledHandler);

    setImageScrollBarHeight();

    return () => {
      const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

      if (!viewportInfo) {
        return;
      }

      cornerstoneViewportService.storePresentation({ viewportId });

      // This should be done after the store presentation since synchronizers
      // will get cleaned up and they need the viewportInfo to be present
      cleanUpServices(viewportInfo);

      if (onElementDisabled) {
        onElementDisabled(viewportInfo);
      }

      cornerstoneViewportService.disableElement(viewportId);

      eventTarget.removeEventListener(Enums.Events.ELEMENT_ENABLED, elementEnabledHandler);
    };
  }, []);

  // subscribe to displaySet metadata invalidation (updates)
  // Currently, if the metadata changes we need to re-render the display set
  // for it to take effect in the viewport. As we deal with scaling in the loading,
  // we need to remove the old volume from the cache, and let the
  // viewport to re-add it which will use the new metadata. Otherwise, the
  // viewport will use the cached volume and the new metadata will not be used.
  // Note: this approach does not actually end of sending network requests
  // and it uses the network cache
  useEffect(() => {
    const { unsubscribe } = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SET_SERIES_METADATA_INVALIDATED,
      async ({
        displaySetInstanceUID: invalidatedDisplaySetInstanceUID,
        invalidateData,
      }: Types.DisplaySetSeriesMetadataInvalidatedEvent) => {
        if (!invalidateData) {
          return;
        }

        const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

        if (viewportInfo.hasDisplaySet(invalidatedDisplaySetInstanceUID)) {
          const viewportData = viewportInfo.getViewportData();
          const newViewportData = await cornerstoneCacheService.invalidateViewportData(
            viewportData,
            invalidatedDisplaySetInstanceUID,
            dataSource,
            displaySetService
          );

          const keepCamera = true;
          cornerstoneViewportService.updateViewport(viewportId, newViewportData, keepCamera);
        }
      }
    );
    return () => {
      unsubscribe();
    };
  }, [viewportId]);

  useEffect(() => {
    // handle the default viewportType to be stack
    if (!viewportOptions.viewportType) {
      viewportOptions.viewportType = STACK;
    }

    const loadViewportData = async () => {
      const viewportData = await cornerstoneCacheService.createViewportData(
        displaySets,
        viewportOptions,
        dataSource,
        initialImageIndex
      );

      // The presentation state will have been stored previously by closing
      // a viewport.  Otherwise, this viewport will be unchanged and the
      // presentation information will be directly carried over.
      const state = stateSyncService.getState();
      const lutPresentationStore = state.lutPresentationStore as LutPresentation;
      const positionPresentationStore = state.positionPresentationStore as PositionPresentation;

      const { presentationIds } = viewportOptions;
      const presentations = {
        positionPresentation: positionPresentationStore[presentationIds?.positionPresentationId],
        lutPresentation: lutPresentationStore[presentationIds?.lutPresentationId],
      };
      let measurement;
      if (cacheJumpToMeasurementEvent?.viewportId === viewportId) {
        measurement = cacheJumpToMeasurementEvent.measurement;
        // Delete the position presentation so that viewport navigates direct
        presentations.positionPresentation = null;
        cacheJumpToMeasurementEvent = null;
      }

      // Note: This is a hack to get the grid to re-render the OHIFCornerstoneViewport component
      // Used for segmentation hydration right now, since the logic to decide whether
      // a viewport needs to render a segmentation lives inside the CornerstoneViewportService
      // so we need to re-render (force update via change of the needsRerendering) so that React
      // does the diffing and decides we should render this again (although the id and element has not changed)
      // so that the CornerstoneViewportService can decide whether to render the segmentation or not. Not that we reached here we can turn it off.
      if (viewportOptions.needsRerendering) {
        viewportOptions.needsRerendering = false;
      }

      cornerstoneViewportService.setViewportData(
        viewportId,
        viewportData,
        viewportOptions,
        displaySetOptions,
        presentations
      );
      if (measurement) {
        cs3DTools.annotation.selection.setAnnotationSelected(measurement.uid);
      }
    };

    loadViewportData();
  }, [viewportOptions, displaySets, dataSource]);

  /**
   * There are two scenarios for jump to click
   * 1. Current viewports contain the displaySet that the annotation was drawn on
   * 2. Current viewports don't contain the displaySet that the annotation was drawn on
   * and we need to change the viewports displaySet for jumping.
   * Since measurement_jump happens via events and listeners, the former case is handled
   * by the measurement_jump direct callback, but the latter case is handled first by
   * the viewportGrid to set the correct displaySet on the viewport, AND THEN we check
   * the cache for jumping to see if there is any jump queued, then we jump to the correct slice.
   */
  useEffect(() => {
    if (isJumpToMeasurementDisabled) {
      return;
    }

    const unsubscribeFromJumpToMeasurementEvents = _subscribeToJumpToMeasurementEvents(
      measurementService,
      displaySetService,
      elementRef,
      viewportId,
      displaySets,
      viewportGridService,
      cornerstoneViewportService
    );

    _checkForCachedJumpToMeasurementEvents(
      measurementService,
      displaySetService,
      elementRef,
      viewportId,
      displaySets,
      viewportGridService,
      cornerstoneViewportService
    );

    return () => {
      unsubscribeFromJumpToMeasurementEvents();
    };
  }, [displaySets, elementRef, viewportId]);

  // Set up the window level action menu in the viewport action corners.
  useEffect(() => {
    // Doing an === check here because the default config value when not set is true
    if (appConfig.addWindowLevelActionMenu === false) {
      return;
    }

    // TODO: In the future we should consider using the customization service
    // to determine if and in which corner various action components should go.
    const wlActionMenu = getWindowLevelActionMenu({
      viewportId,
      element: elementRef.current,
      displaySets,
      servicesManager,
      commandsManager,
      verticalDirection: AllInOneMenu.VerticalDirection.TopToBottom,
      horizontalDirection: AllInOneMenu.HorizontalDirection.RightToLeft,
    });

    viewportActionCornersService.setComponent({
      viewportId,
      id: 'windowLevelActionMenu',
      component: wlActionMenu,
      location: viewportActionCornersService.LOCATIONS.topRight,
      indexPriority: -100,
    });
  }, [displaySets, viewportId, viewportActionCornersService, servicesManager, commandsManager]);

  const { ref: resizeRef } = useResizeDetector({
    onResize,
  });
  return (
    <React.Fragment>
      <div className="viewport-wrapper">
        <div
          className="cornerstone-viewport-element"
          style={{ height: '55%', width: '100%' }}
          onContextMenu={e => e.preventDefault()}
          onMouseDown={e => e.preventDefault()}
          ref={el => {
            resizeRef.current = el;
            elementRef.current = el;
          }}
        ></div>
        {/* Add the reactive graph below. UI components in the problem
        screenshot are present in other parts of the page, or their functions
        are otherwise handled by other parts of the workflow. */}
        <div
          className="cornerstone-viewport-graph"
          style={{ height: '45%', width: '100%', padding: '2%' }}
        >
          <LineChart
            showLegend={false}
            axis={axis}
            series={series}
          ></LineChart>
        </div>
        <CornerstoneOverlays
          viewportId={viewportId}
          toolBarService={toolbarService}
          element={elementRef.current}
          scrollbarHeight={scrollbarHeight}
          servicesManager={servicesManager}
          updateNotifier={makeGraphUpdateCallback}
        />
        <CinePlayer
          enabledVPElement={enabledVPElement}
          viewportId={viewportId}
          servicesManager={servicesManager}
        />
      </div>
      {/* top offset of 24px to account for ViewportActionCorners. */}
      <div className="absolute top-[24px] w-full">
        {viewportDialogState.viewportId === viewportId && (
          <Notification
            id="viewport-notification"
            message={viewportDialogState.message}
            type={viewportDialogState.type}
            actions={viewportDialogState.actions}
            onSubmit={viewportDialogState.onSubmit}
            onOutsideClick={viewportDialogState.onOutsideClick}
            onKeyPress={viewportDialogState.onKeyPress}
          />
        )}
      </div>
      {/* The OHIFViewportActionCorners follows the viewport in the DOM so that it is naturally at a higher z-index.*/}
      <OHIFViewportActionCorners viewportId={viewportId} />
    </React.Fragment>
  );
}, areEqual);

function _subscribeToJumpToMeasurementEvents(
  measurementService,
  displaySetService,
  elementRef,
  viewportId,
  displaySets,
  viewportGridService,
  cornerstoneViewportService
) {
  const { unsubscribe } = measurementService.subscribe(
    MeasurementService.EVENTS.JUMP_TO_MEASUREMENT_VIEWPORT,
    props => {
      cacheJumpToMeasurementEvent = props;
      const { viewportId: jumpId, measurement, isConsumed } = props;
      if (!measurement || isConsumed) {
        return;
      }
      if (cacheJumpToMeasurementEvent.cornerstoneViewport === undefined) {
        // Decide on which viewport should handle this
        cacheJumpToMeasurementEvent.cornerstoneViewport =
          cornerstoneViewportService.getViewportIdToJump(
            jumpId,
            measurement.displaySetInstanceUID,
            {
              referencedImageId:
                measurement.referencedImageId || measurement.metadata?.referencedImageId,
            }
          );
      }
      if (cacheJumpToMeasurementEvent.cornerstoneViewport !== viewportId) {
        return;
      }
      _jumpToMeasurement(
        measurement,
        elementRef,
        viewportId,
        measurementService,
        displaySetService,
        viewportGridService,
        cornerstoneViewportService
      );
    }
  );

  return unsubscribe;
}

// Check if there is a queued jumpToMeasurement event
function _checkForCachedJumpToMeasurementEvents(
  measurementService,
  displaySetService,
  elementRef,
  viewportId,
  displaySets,
  viewportGridService,
  cornerstoneViewportService
) {
  if (!cacheJumpToMeasurementEvent) {
    return;
  }
  if (cacheJumpToMeasurementEvent.isConsumed) {
    cacheJumpToMeasurementEvent = null;
    return;
  }
  const displaysUIDs = displaySets.map(displaySet => displaySet.displaySetInstanceUID);
  if (!displaysUIDs?.length) {
    return;
  }

  // Jump to measurement if the measurement exists
  const { measurement } = cacheJumpToMeasurementEvent;
  if (measurement && elementRef) {
    if (displaysUIDs.includes(measurement?.displaySetInstanceUID)) {
      _jumpToMeasurement(
        measurement,
        elementRef,
        viewportId,
        measurementService,
        displaySetService,
        viewportGridService,
        cornerstoneViewportService
      );
    }
  }
}

function _jumpToMeasurement(
  measurement,
  targetElementRef,
  viewportId,
  measurementService,
  displaySetService,
  viewportGridService,
  cornerstoneViewportService
) {
  const targetElement = targetElementRef.current;
  const { displaySetInstanceUID, SOPInstanceUID, frameNumber } = measurement;

  if (!SOPInstanceUID) {
    console.warn('cannot jump in a non-acquisition plane measurements yet');
    return;
  }

  const referencedDisplaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

  // Todo: setCornerstoneMeasurementActive should be handled by the toolGroupManager
  //  to set it properly
  // setCornerstoneMeasurementActive(measurement);

  viewportGridService.setActiveViewportId(viewportId);

  const enabledElement = getEnabledElement(targetElement);

  if (enabledElement) {
    // See how the jumpToSlice() of Cornerstone3D deals with imageIdx param.
    const viewport = enabledElement.viewport as IStackViewport | IVolumeViewport;

    let imageIdIndex = 0;
    let viewportCameraDirectionMatch = true;

    if (viewport instanceof StackViewport) {
      const imageIds = viewport.getImageIds();
      imageIdIndex = imageIds.findIndex(imageId => {
        const { SOPInstanceUID: aSOPInstanceUID, frameNumber: aFrameNumber } =
          getSOPInstanceAttributes(imageId);
        return aSOPInstanceUID === SOPInstanceUID && (!frameNumber || frameNumber === aFrameNumber);
      });
    } else {
      // for volume viewport we can't rely on the imageIdIndex since it can be
      // a reconstructed view that doesn't match the original slice numbers etc.
      const { viewPlaneNormal: measurementViewPlane } = measurement.metadata;
      imageIdIndex = referencedDisplaySet.images.findIndex(
        i => i.SOPInstanceUID === SOPInstanceUID
      );

      // the index is reversed in the volume viewport
      // imageIdIndex = referencedDisplaySet.images.length - 1 - imageIdIndex;

      const { viewPlaneNormal: viewportViewPlane } = viewport.getCamera();

      // should compare abs for both planes since the direction can be flipped
      if (
        measurementViewPlane &&
        !csUtils.isEqual(measurementViewPlane.map(Math.abs), viewportViewPlane.map(Math.abs))
      ) {
        viewportCameraDirectionMatch = false;
      }
    }

    if (!viewportCameraDirectionMatch || imageIdIndex === -1) {
      return;
    }

    cs3DTools.utilities.jumpToSlice(targetElement, {
      imageIndex: imageIdIndex,
    });

    cs3DTools.annotation.selection.setAnnotationSelected(measurement.uid);
    // Jump to measurement consumed, remove.
    cacheJumpToMeasurementEvent?.consume?.();
    cacheJumpToMeasurementEvent = null;
  }
}

function _rehydrateSynchronizers(
  synchronizersStore: { [key: string]: unknown },
  viewportId: string,
  syncGroupService: any
) {
  synchronizersStore[viewportId].forEach(synchronizerObj => {
    if (!synchronizerObj.id) {
      return;
    }

    const { id, sourceViewports, targetViewports } = synchronizerObj;

    const synchronizer = syncGroupService.getSynchronizer(id);

    if (!synchronizer) {
      return;
    }

    const sourceViewportInfo = sourceViewports.find(
      sourceViewport => sourceViewport.viewportId === viewportId
    );

    const targetViewportInfo = targetViewports.find(
      targetViewport => targetViewport.viewportId === viewportId
    );

    const isSourceViewportInSynchronizer = synchronizer
      .getSourceViewports()
      .find(sourceViewport => sourceViewport.viewportId === viewportId);

    const isTargetViewportInSynchronizer = synchronizer
      .getTargetViewports()
      .find(targetViewport => targetViewport.viewportId === viewportId);

    // if the viewport was previously a source viewport, add it again
    if (sourceViewportInfo && !isSourceViewportInSynchronizer) {
      synchronizer.addSource({
        viewportId: sourceViewportInfo.viewportId,
        renderingEngineId: sourceViewportInfo.renderingEngineId,
      });
    }

    // if the viewport was previously a target viewport, add it again
    if (targetViewportInfo && !isTargetViewportInSynchronizer) {
      synchronizer.addTarget({
        viewportId: targetViewportInfo.viewportId,
        renderingEngineId: targetViewportInfo.renderingEngineId,
      });
    }
  });
}

// Component displayName
OHIFCornerstoneViewport.displayName = 'OHIFCornerstoneViewport';

OHIFCornerstoneViewport.propTypes = {
  displaySets: PropTypes.array.isRequired,
  dataSource: PropTypes.object.isRequired,
  viewportOptions: PropTypes.object,
  displaySetOptions: PropTypes.arrayOf(PropTypes.any),
  servicesManager: PropTypes.object.isRequired,
  onElementEnabled: PropTypes.func,
  isJumpToMeasurementDisabled: PropTypes.bool,
  // Note: you SHOULD NOT use the initialImageIdOrIndex for manipulation
  // of the imageData in the OHIFCornerstoneViewport. This prop is used
  // to set the initial state of the viewport's first image to render
  initialImageIdOrIndex: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
};

const _getCurrentFrameImageId = function (
  displaySets,
  currentImageSlice?: number
): string | undefined {
  if (currentImageSlice == null || currentImageSlice === undefined || displaySets == null) {
    return;
  }
  return displaySets[0]?.instances[currentImageSlice]?.imageId;
};

const _getPointsForGraph = function (currentImageId?: string): number[][] {
  const points = [];

  const cachedImage = currentImageId
    ? cache.getCachedImageBasedOnImageURI(currentImageId)
    : undefined;

  const pixelData = cachedImage?.image?.getPixelData();
  const L = pixelData?.length || 0;
  if (L === 0) {
    points.push([0, 0]);
  }

  /* For the purpose of illustration, we will create points to graph based on cached image pixel data.
  For an actual application, we would read other cached data for the graph.
  The actual pixel data used and transformations we apply are arbitrary just for aesthetics.
  We would also have to take into account the encoding to
  */

  // use [0,1] default range to avoid division by 0.
  const low = cachedImage?.image?.minPixelValue || 0;
  const high = cachedImage?.image?.maxPixelValue || 1;

  for (let i = 0; i < L; i += Math.round(L / 10)) {
    points.push([i / L, (pixelData[i] - low) / (high - low)]); // rescale x & y values to be in [0,1]
  }
  return points;
};

export default OHIFCornerstoneViewport;
