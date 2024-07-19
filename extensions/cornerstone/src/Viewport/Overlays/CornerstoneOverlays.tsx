import React, { useCallback, useEffect, useState } from 'react';

import ViewportImageScrollbar from './ViewportImageScrollbar';
import CustomizableViewportOverlay from './CustomizableViewportOverlay';
import ViewportOrientationMarkers from './ViewportOrientationMarkers';
import ViewportImageSliceLoadingIndicator from './ViewportImageSliceLoadingIndicator';

function CornerstoneOverlays(props: withAppTypes) {
  const { viewportId, element, scrollbarHeight, servicesManager, updateNotifier } = props;
  const { cornerstoneViewportService } = servicesManager.services;
  const [imageSliceData, setImageSliceData] = useState({
    imageIndex: 0,
    numberOfSlices: 0,
  });
  const [viewportData, setViewportData] = useState(null);

  // wrap the callback for the slider to call the callback to update the parent
  const setImageSliceDataWrapper = useCallback(
    (sliceData: { imageIndex: number; numberOfSlices: number }) => {
      setImageSliceData(sliceData);
      updateNotifier();
    },
    [setImageSliceData, updateNotifier]
  );

  useEffect(() => {
    const { unsubscribe } = cornerstoneViewportService.subscribe(
      cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
      props => {
        if (props.viewportId !== viewportId) {
          return;
        }

        setViewportData(props.viewportData);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [viewportId]);

  if (!element) {
    return null;
  }

  if (viewportData) {
    const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);

    if (viewportInfo?.viewportOptions?.customViewportProps?.hideOverlays) {
      return null;
    }
  }

  return (
    <div className="noselect">
      <ViewportImageScrollbar
        viewportId={viewportId}
        viewportData={viewportData}
        element={element}
        imageSliceData={imageSliceData}
        setImageSliceData={setImageSliceDataWrapper}
        scrollbarHeight={scrollbarHeight}
        servicesManager={servicesManager}
      />

      <CustomizableViewportOverlay
        imageSliceData={imageSliceData}
        viewportData={viewportData}
        viewportId={viewportId}
        servicesManager={servicesManager}
        element={element}
      />

      <ViewportImageSliceLoadingIndicator
        viewportData={viewportData}
        element={element}
      />

      <ViewportOrientationMarkers
        imageSliceData={imageSliceData}
        element={element}
        viewportData={viewportData}
        servicesManager={servicesManager}
        viewportId={viewportId}
      />
    </div>
  );
}

export default CornerstoneOverlays;
