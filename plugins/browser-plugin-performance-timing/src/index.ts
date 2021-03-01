/*
 * Copyright (c) 2021 Snowplow Analytics Ltd, 2010 Anthon Pang
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { BrowserPlugin } from '@snowplow/browser-core';
import { PerformanceTiming } from './contexts';

declare global {
  interface Window {
    mozPerformance: any;
    msPerformance: any;
    webkitPerformance: any;
  }
}

export function PerformanceTimingPlugin(): BrowserPlugin {
  const windowAlias = window;

  /**
   * Creates a context from the window.performance.timing object
   *
   * @return object PerformanceTiming context
   */
  function getPerformanceTimingContext() {
    var performance =
      windowAlias.performance ||
      windowAlias.mozPerformance ||
      windowAlias.msPerformance ||
      windowAlias.webkitPerformance;

    if (performance) {
      const performanceTiming: PerformanceTiming = {
        navigationStart: performance.timing.navigationStart,
        redirectStart: performance.timing.redirectStart,
        redirectEnd: performance.timing.redirectEnd,
        fetchStart: performance.timing.fetchStart,
        domainLookupStart: performance.timing.domainLookupStart,
        domainLookupEnd: performance.timing.domainLookupEnd,
        connectStart: performance.timing.connectStart,
        secureConnectionStart: performance.timing.secureConnectionStart,
        connectEnd: performance.timing.connectEnd,
        requestStart: performance.timing.requestStart,
        responseStart: performance.timing.responseStart,
        responseEnd: performance.timing.responseEnd,
        unloadEventStart: performance.timing.unloadEventStart,
        unloadEventEnd: performance.timing.unloadEventEnd,
        domLoading: performance.timing.domLoading,
        domInteractive: performance.timing.domInteractive,
        domContentLoadedEventStart: performance.timing.domContentLoadedEventStart,
        domContentLoadedEventEnd: performance.timing.domContentLoadedEventEnd,
        domComplete: performance.timing.domComplete,
        loadEventStart: performance.timing.loadEventStart,
        loadEventEnd: performance.timing.loadEventEnd,
        msFirstPaint: (<any>performance.timing).msFirstPaint,
        chromeFirstPaint: (<any>performance.timing).chromeFirstPaint,
        requestEnd: (<any>performance.timing).requestEnd,
        proxyStart: (<any>performance.timing).proxyStart,
        proxyEnd: (<any>performance.timing).proxyEnd,
      };

      return [
        {
          schema: 'iglu:org.w3/PerformanceTiming/jsonschema/1-0-0',
          data: performanceTiming,
        },
      ];
    }

    return [];
  }

  return {
    contexts: () => getPerformanceTimingContext(),
  };
}