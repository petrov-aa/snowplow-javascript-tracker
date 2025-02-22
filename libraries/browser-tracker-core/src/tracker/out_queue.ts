import { attemptWriteLocalStorage, isString } from '../helpers';
import { SharedState } from '../state';
import { localStorageAccessible } from '../detectors';
import { LOG, Payload } from '@snowplow/tracker-core';
import { PAYLOAD_DATA_SCHEMA } from './schemata';
import { EventBatch, RequestFailure } from './types';

export interface OutQueue {
  enqueueRequest: (request: Payload, url: string) => void;
  executeQueue: () => void;
  setUseLocalStorage: (localStorage: boolean) => void;
  setAnonymousTracking: (anonymous: boolean) => void;
  setCollectorUrl: (url: string) => void;
  setBufferSize: (bufferSize: number) => void;
}

/**
 * Object handling sending events to a collector.
 * Instantiated once per tracker instance.
 *
 * @param id - The Snowplow function name (used to generate the localStorage key)
 * @param sharedSate - Stores reference to the outbound queue so it can unload the page when all queues are empty
 * @param useLocalStorage - Whether to use localStorage at all
 * @param eventMethod - if null will use 'beacon' otherwise can be set to 'post', 'get', or 'beacon' to force.
 * @param postPath - The path where events are to be posted
 * @param bufferSize - How many events to batch in localStorage before sending them all
 * @param maxPostBytes - Maximum combined size in bytes of the event JSONs in a POST request
 * @param maxGetBytes - Maximum size in bytes of the complete event URL string in a GET request. 0 for no limit.
 * @param useStm - Whether to add timestamp to events
 * @param maxLocalStorageQueueSize - Maximum number of queued events we will attempt to store in local storage
 * @param connectionTimeout - Defines how long to wait before aborting the request
 * @param anonymousTracking - Defines whether to set the SP-Anonymous header for anonymous tracking on GET and POST
 * @param customHeaders - Allows custom headers to be defined and passed on XMLHttpRequest requests
 * @param withCredentials - Sets the value of the withCredentials flag on XMLHttpRequest (GET and POST) requests
 * @param retryStatusCodes – Failure HTTP response status codes from Collector for which sending events should be retried (they can override the `dontRetryStatusCodes`)
 * @param dontRetryStatusCodes – Failure HTTP response status codes from Collector for which sending events should not be retried
 * @param idService - Id service full URL. This URL will be added to the queue and will be called using a GET method.
 * @param retryFailedRequests - Whether to retry failed requests - Takes precedent over `retryStatusCodes` and `dontRetryStatusCodes`
 * @param onRequestSuccess - Function called when a request succeeds
 * @param onRequestFailure - Function called when a request does not succeed
 * @returns object OutQueueManager instance
 */
export function OutQueueManager(
  id: string,
  sharedSate: SharedState,
  useLocalStorage: boolean,
  eventMethod: string | boolean,
  postPath: string,
  bufferSize: number,
  maxPostBytes: number,
  maxGetBytes: number,
  useStm: boolean,
  maxLocalStorageQueueSize: number,
  connectionTimeout: number,
  anonymousTracking: boolean,
  customHeaders: Record<string, string>,
  withCredentials: boolean,
  retryStatusCodes: number[],
  dontRetryStatusCodes: number[],
  idService?: string,
  retryFailedRequests: boolean = true,
  onRequestSuccess?: (data: EventBatch) => void,
  onRequestFailure?: (data: RequestFailure) => void
): OutQueue {
  type PostEvent = {
    evt: Record<string, unknown>;
    bytes: number;
  };

  let executingQueue = false,
    configCollectorUrl: string,
    outQueue: Array<PostEvent> | Array<string> = [],
    idServiceCalled = false;

  //Force to lower case if its a string
  eventMethod = typeof eventMethod === 'string' ? eventMethod.toLowerCase() : eventMethod;

  // Use the Beacon API if eventMethod is set true, 'true', or 'beacon'.
  const isBeaconRequested = eventMethod === true || eventMethod === 'beacon' || eventMethod === 'true',
    // Fall back to POST or GET for browsers which don't support Beacon API
    isBeaconAvailable = Boolean(
      isBeaconRequested &&
        window.navigator &&
        window.navigator.sendBeacon &&
        !hasWebKitBeaconBug(window.navigator.userAgent)
    ),
    useBeacon = isBeaconAvailable && isBeaconRequested,
    // Use GET if specified
    isGetRequested = eventMethod === 'get',
    // Don't use XhrHttpRequest for browsers which don't support CORS XMLHttpRequests (e.g. IE <= 9)
    useXhr = Boolean(window.XMLHttpRequest && 'withCredentials' in new XMLHttpRequest()),
    // Use POST if specified
    usePost = !isGetRequested && useXhr && (eventMethod === 'post' || isBeaconRequested),
    // Resolve all options and capabilities and decide path
    path = usePost ? postPath : '/i',
    // Different queue names for GET and POST since they are stored differently
    queueName = `snowplowOutQueue_${id}_${usePost ? 'post2' : 'get'}`;

  // Ensure we don't set headers when beacon is the requested eventMethod as we might fallback to POST
  // and end up sending them in older browsers which don't support beacon leading to inconsistencies
  if (isBeaconRequested) customHeaders = {};

  // Get buffer size or set 1 if unable to buffer
  bufferSize = (useLocalStorage && localStorageAccessible() && usePost && bufferSize) || 1;

  if (useLocalStorage) {
    // Catch any JSON parse errors or localStorage that might be thrown
    try {
      const localStorageQueue = window.localStorage.getItem(queueName);
      outQueue = localStorageQueue ? JSON.parse(localStorageQueue) : [];
    } catch (e) {}
  }

  // Initialize to and empty array if we didn't get anything out of localStorage
  if (!Array.isArray(outQueue)) {
    outQueue = [];
  }

  // Used by pageUnloadGuard
  sharedSate.outQueues.push(outQueue);

  if (useXhr && bufferSize > 1) {
    sharedSate.bufferFlushers.push(function (sync) {
      if (!executingQueue) {
        executeQueue(sync);
      }
    });
  }

  /*
   * Convert a dictionary to a querystring
   * The context field is the last in the querystring
   */
  function getQuerystring(request: Payload) {
    let querystring = '?',
      lowPriorityKeys = { co: true, cx: true },
      firstPair = true;

    for (const key in request) {
      if (request.hasOwnProperty(key) && !lowPriorityKeys.hasOwnProperty(key)) {
        if (!firstPair) {
          querystring += '&';
        } else {
          firstPair = false;
        }
        querystring += encodeURIComponent(key) + '=' + encodeURIComponent(request[key] as string | number | boolean);
      }
    }

    for (const contextKey in lowPriorityKeys) {
      if (request.hasOwnProperty(contextKey) && lowPriorityKeys.hasOwnProperty(contextKey)) {
        querystring += '&' + contextKey + '=' + encodeURIComponent(request[contextKey] as string | number | boolean);
      }
    }

    return querystring;
  }

  /*
   * Convert numeric fields to strings to match payload_data schema
   */
  function getBody(request: Payload): PostEvent {
    const cleanedRequest = Object.keys(request)
      .map<[string, unknown]>((k) => [k, request[k]])
      .reduce((acc, [key, value]) => {
        acc[key] = (value as Object).toString();
        return acc;
      }, {} as Record<string, unknown>);
    return {
      evt: cleanedRequest,
      bytes: getUTF8Length(JSON.stringify(cleanedRequest)),
    };
  }

  /**
   * Count the number of bytes a string will occupy when UTF-8 encoded
   * Taken from http://stackoverflow.com/questions/2848462/count-bytes-in-textarea-using-javascript/
   *
   * @param string - s
   * @returns number Length of s in bytes when UTF-8 encoded
   */
  function getUTF8Length(s: string) {
    let len = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code <= 0x7f) {
        len += 1;
      } else if (code <= 0x7ff) {
        len += 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        // Surrogate pair: These take 4 bytes in UTF-8 and 2 chars in UCS-2
        // (Assume next char is the other [valid] half and just skip it)
        len += 4;
        i++;
      } else if (code < 0xffff) {
        len += 3;
      } else {
        len += 4;
      }
    }
    return len;
  }

  const postable = (queue: Array<PostEvent> | Array<string>): queue is Array<PostEvent> => {
    return typeof queue[0] === 'object' && 'evt' in queue[0];
  };

  /**
   * Send event as POST request right away without going to queue. Used when the request surpasses maxGetBytes or maxPostBytes
   * @param body POST request body
   * @param configCollectorUrl full collector URL with path
   */
  function sendPostRequestWithoutQueueing(body: PostEvent, configCollectorUrl: string) {
    const xhr = initializeXMLHttpRequest(configCollectorUrl, true, false);
    const batch = attachStmToEvent([body.evt]);

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (isSuccessfulRequest(xhr.status)) {
          onRequestSuccess?.(batch);
        } else {
          onRequestFailure?.({
            status: xhr.status,
            message: xhr.statusText,
            events: batch,
            willRetry: false,
          });
        }
      }
    };

    xhr.send(encloseInPayloadDataEnvelope(batch));
  }

  function removeEventsFromQueue(numberToSend: number): void {
    for (let deleteCount = 0; deleteCount < numberToSend; deleteCount++) {
      outQueue.shift();
    }
    if (useLocalStorage) {
      attemptWriteLocalStorage(queueName, JSON.stringify(outQueue.slice(0, maxLocalStorageQueueSize)));
    }
  }

  function setXhrCallbacks(xhr: XMLHttpRequest, numberToSend: number, batch: EventBatch) {
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        clearTimeout(xhrTimeout);
        if (isSuccessfulRequest(xhr.status)) {
          removeEventsFromQueue(numberToSend);
          onRequestSuccess?.(batch);
          executeQueue();
        } else {
          const willRetry = shouldRetryForStatusCode(xhr.status);
          if (!willRetry) {
            LOG.error(`Status ${xhr.status}, will not retry.`);
            removeEventsFromQueue(numberToSend);
          }
          onRequestFailure?.({
            status: xhr.status,
            message: xhr.statusText,
            events: batch,
            willRetry,
          });

          executingQueue = false;
        }
      }
    };

    // Time out POST requests after connectionTimeout
    const xhrTimeout = setTimeout(function () {
      xhr.abort();
      if (!retryFailedRequests) {
        removeEventsFromQueue(numberToSend);
      }
      onRequestFailure?.({
        status: 0,
        message: 'timeout',
        events: batch,
        willRetry: retryFailedRequests,
      });
      executingQueue = false;
    }, connectionTimeout);
  }

  /*
   * Queue for submission to the collector and start processing queue
   */
  function enqueueRequest(request: Payload, url: string) {
    configCollectorUrl = url + path;
    const eventTooBigWarning = (bytes: number, maxBytes: number) =>
      LOG.warn('Event (' + bytes + 'B) too big, max is ' + maxBytes);

    if (usePost) {
      const body = getBody(request);
      if (body.bytes >= maxPostBytes) {
        eventTooBigWarning(body.bytes, maxPostBytes);
        sendPostRequestWithoutQueueing(body, configCollectorUrl);
        return;
      } else {
        (outQueue as Array<PostEvent>).push(body);
      }
    } else {
      const querystring = getQuerystring(request);
      if (maxGetBytes > 0) {
        const requestUrl = createGetUrl(querystring);
        const bytes = getUTF8Length(requestUrl);
        if (bytes >= maxGetBytes) {
          eventTooBigWarning(bytes, maxGetBytes);
          if (useXhr) {
            const body = getBody(request);
            const postUrl = url + postPath;
            sendPostRequestWithoutQueueing(body, postUrl);
          }
          return;
        }
      }
      (outQueue as Array<string>).push(querystring);
    }
    let savedToLocalStorage = false;
    if (useLocalStorage) {
      savedToLocalStorage = attemptWriteLocalStorage(
        queueName,
        JSON.stringify(outQueue.slice(0, maxLocalStorageQueueSize))
      );
    }

    // If we're not processing the queue, we'll start.
    if (!executingQueue && (!savedToLocalStorage || outQueue.length >= bufferSize)) {
      executeQueue();
    }
  }

  /*
   * Run through the queue of requests, sending them one at a time.
   * Stops processing when we run out of queued requests, or we get an error.
   */
  function executeQueue(sync: boolean = false) {
    // Failsafe in case there is some way for a bad value like "null" to end up in the outQueue
    while (outQueue.length && typeof outQueue[0] !== 'string' && typeof outQueue[0] !== 'object') {
      outQueue.shift();
    }

    if (!outQueue.length) {
      executingQueue = false;
      return;
    }

    // Let's check that we have a URL
    if (!isString(configCollectorUrl)) {
      throw 'No collector configured';
    }

    executingQueue = true;

    if (idService && !idServiceCalled) {
      const xhr = initializeXMLHttpRequest(idService, false, sync);
      idServiceCalled = true;
      xhr.timeout = connectionTimeout;
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          executeQueue();
        }
      };
      xhr.send();
      return;
    }

    if (useXhr) {
      // Keep track of number of events to delete from queue
      const chooseHowManyToSend = (queue: Array<{ bytes: number }>) => {
        let numberToSend = 0,
          byteCount = 0;
        while (numberToSend < queue.length) {
          byteCount += queue[numberToSend].bytes;
          if (byteCount >= maxPostBytes) {
            break;
          } else {
            numberToSend += 1;
          }
        }
        return numberToSend;
      };

      let url: string, xhr: XMLHttpRequest, numberToSend: number;
      if (postable(outQueue)) {
        url = configCollectorUrl;
        xhr = initializeXMLHttpRequest(url, true, sync);
        numberToSend = chooseHowManyToSend(outQueue);
      } else {
        url = createGetUrl(outQueue[0]);
        xhr = initializeXMLHttpRequest(url, false, sync);
        numberToSend = 1;
      }

      if (!postable(outQueue)) {
        // If not postable then it's a GET so just send it
        setXhrCallbacks(xhr, numberToSend, [url]);
        xhr.send();
      } else {
        let batch = outQueue.slice(0, numberToSend);

        if (batch.length > 0) {
          let beaconStatus = false;

          const eventBatch = batch.map(function (x) {
            return x.evt;
          });

          if (useBeacon) {
            const blob = new Blob([encloseInPayloadDataEnvelope(attachStmToEvent(eventBatch))], {
              type: 'application/json',
            });
            try {
              beaconStatus = navigator.sendBeacon(url, blob);
            } catch (error) {
              beaconStatus = false;
            }
          }

          // When beaconStatus is true, we can't _guarantee_ that it was successful (beacon queues asynchronously)
          // but the browser has taken it out of our hands, so we want to flush the queue assuming it will do its job
          if (beaconStatus === true) {
            removeEventsFromQueue(numberToSend);
            onRequestSuccess?.(batch);
            executeQueue();
          } else {
            const batch = attachStmToEvent(eventBatch);
            setXhrCallbacks(xhr, numberToSend, batch);
            xhr.send(encloseInPayloadDataEnvelope(batch));
          }
        }
      }
    } else if (!anonymousTracking && !postable(outQueue)) {
      // We can't send with this technique if anonymous tracking is on as we can't attach the header
      let image = new Image(1, 1),
        loading = true;

      image.onload = function () {
        if (!loading) return;
        loading = false;
        outQueue.shift();
        if (useLocalStorage) {
          attemptWriteLocalStorage(queueName, JSON.stringify(outQueue.slice(0, maxLocalStorageQueueSize)));
        }
        executeQueue();
      };

      image.onerror = function () {
        if (!loading) return;
        loading = false;
        executingQueue = false;
      };

      image.src = createGetUrl(outQueue[0]);

      setTimeout(function () {
        if (loading && executingQueue) {
          loading = false;
          executeQueue();
        }
      }, connectionTimeout);
    } else {
      executingQueue = false;
    }
  }

  /**
   * Determines whether a request was successful, based on its status code
   * Anything in the 2xx range is considered successful
   *
   * @param statusCode The status code of the request
   * @returns Whether the request was successful
   */
  function isSuccessfulRequest(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
  }

  function shouldRetryForStatusCode(statusCode: number) {
    // success, don't retry
    if (isSuccessfulRequest(statusCode)) {
      return false;
    }

    if (!retryFailedRequests) {
      return false;
    }

    // retry if status code among custom user-supplied retry codes
    if (retryStatusCodes.includes(statusCode)) {
      return true;
    }

    // retry if status code *not* among the don't retry codes
    return !dontRetryStatusCodes.includes(statusCode);
  }

  /**
   * Open an XMLHttpRequest for a given endpoint with the correct credentials and header
   *
   * @param string - url The destination URL
   * @returns object The XMLHttpRequest
   */
  function initializeXMLHttpRequest(url: string, post: boolean, sync: boolean) {
    const xhr = new XMLHttpRequest();
    if (post) {
      xhr.open('POST', url, !sync);
      xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    } else {
      xhr.open('GET', url, !sync);
    }
    xhr.withCredentials = withCredentials;
    if (anonymousTracking) {
      xhr.setRequestHeader('SP-Anonymous', '*');
    }
    for (const header in customHeaders) {
      if (Object.prototype.hasOwnProperty.call(customHeaders, header)) {
        xhr.setRequestHeader(header, customHeaders[header]);
      }
    }
    return xhr;
  }

  /**
   * Enclose an array of events in a self-describing payload_data JSON string
   *
   * @param array - events Batch of events
   * @returns string payload_data self-describing JSON
   */
  function encloseInPayloadDataEnvelope(events: Array<Record<string, unknown>>) {
    return JSON.stringify({
      schema: PAYLOAD_DATA_SCHEMA,
      data: events,
    });
  }

  /**
   * Attaches the STM field to outbound POST events.
   *
   * @param events - the events to attach the STM to
   */
  function attachStmToEvent(events: Array<Record<string, unknown>>) {
    const stm = new Date().getTime().toString();
    for (let i = 0; i < events.length; i++) {
      events[i]['stm'] = stm;
    }
    return events;
  }

  /**
   * Creates the full URL for sending the GET request. Will append `stm` if enabled
   *
   * @param nextRequest - the query string of the next request
   */
  function createGetUrl(nextRequest: string) {
    if (useStm) {
      return configCollectorUrl + nextRequest.replace('?', '?stm=' + new Date().getTime() + '&');
    }

    return configCollectorUrl + nextRequest;
  }

  return {
    enqueueRequest: enqueueRequest,
    executeQueue: () => {
      if (!executingQueue) {
        executeQueue();
      }
    },
    setUseLocalStorage: (localStorage: boolean) => {
      useLocalStorage = localStorage;
    },
    setAnonymousTracking: (anonymous: boolean) => {
      anonymousTracking = anonymous;
    },
    setCollectorUrl: (url: string) => {
      configCollectorUrl = url + path;
    },
    setBufferSize: (newBufferSize: number) => {
      bufferSize = newBufferSize;
    },
  };

  function hasWebKitBeaconBug(useragent: string) {
    return (
      isIosVersionLessThanOrEqualTo(13, useragent) ||
      (isMacosxVersionLessThanOrEqualTo(10, 15, useragent) && isSafari(useragent))
    );

    function isIosVersionLessThanOrEqualTo(major: number, useragent: string) {
      const match = useragent.match('(iP.+; CPU .*OS (d+)[_d]*.*) AppleWebKit/');
      if (match && match.length) {
        return parseInt(match[0]) <= major;
      }
      return false;
    }

    function isMacosxVersionLessThanOrEqualTo(major: number, minor: number, useragent: string) {
      const match = useragent.match('(Macintosh;.*Mac OS X (d+)_(d+)[_d]*.*) AppleWebKit/');
      if (match && match.length) {
        return parseInt(match[0]) <= major || (parseInt(match[0]) === major && parseInt(match[1]) <= minor);
      }
      return false;
    }

    function isSafari(useragent: string) {
      return useragent.match('Version/.* Safari/') && !isChromiumBased(useragent);
    }

    function isChromiumBased(useragent: string) {
      return useragent.match('Chrom(e|ium)');
    }
  }
}
