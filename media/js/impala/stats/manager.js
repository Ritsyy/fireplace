function dbg() {
    if(window.console && (typeof window.console.log == 'function')) {
        window.console.log(Array.prototype.slice.apply(arguments));
    }
}

z.hasPushState = (typeof history.replaceState === "function");

z.StatsManager = (function() {
    "use strict";

    // The version of the stats localStorage we are using.
    // If you increment this number, you cache-bust everyone!
    var STATS_VERSION = '2011-10-21-1';

    var storage         = z.Storage("stats"),
        storageCache    = z.Storage("statscache"),
        dataStore       = {},
        currentView     = {},
        addonId         = parseInt($(".primary").attr("data-addon_id"), 10),
        baseURL         = $(".primary").attr("data-base_url"),
        pendingFetches  = 0,
        writeInterval   = false;

    // It's a bummer, but we need to know which metrics have breakdown fields.
    // check by saying `if (metric in breakdownMetrics)`
    var breakdownMetrics = {
        "apps": true,
        "locales": true,
        "os": true,
        "sources": true,
        "versions": true,
        "statuses": true,
        "overview": true
    };

    // is a metric an average or a sum?
    var metricTypes = {
        "usage"     : "mean",
        "apps"      : "mean",
        "locales"   : "mean",
        "os"        : "mean",
        "versions"  : "mean",
        "statuses"  : "mean",
        "downloads" : "sum",
        "sources"   : "sum"
    };

    // Initialize from localStorage when dom is ready.
    function init() {
        dbg("looking for local data");
        if (verifyLocalStorage()) {
            var cacheObject = storageCache.get(addonId);
            if (cacheObject) {
                dbg("found local data, loading...");
                cacheObject = JSON.parse(cacheObject);
                if (cacheObject) {
                    dataStore = cacheObject;
                }
            }
        }
    }
    $(init);

    // These functions deal with our localStorage cache.

    function writeLocalStorage() {
        dbg("saving local data");
        try {
            storageCache.set(addonId, JSON.stringify(dataStore));
            storage.set("version", STATS_VERSION);
        } catch (e) {
            console.log(e);
        }
        dbg("saved local data");
    }

    function clearLocalStorage() {
        storageCache.remove(addonId);
        storage.remove("version");
        dbg("cleared local data");
    }

    function verifyLocalStorage() {
        if (storage.get("version") == STATS_VERSION) {
            return true;
        } else {
            dbg("wrong offline data verion");
            clearLocalStorage();
            return false;
        }
    }

    document.onbeforeunload = writeLocalStorage;


    // Runs when 'changeview' event is detected.
    function processView(e, newView) {
        // Update our internal view state.
        currentView = $.extend(currentView, newView);
        // Fetch the data from the server or storage, and notify other components.
        $.when( getDataRange(currentView) )
         .then( function(data) {
            setTimeout(function() {
                $(window).trigger("dataready", {
                    'view'  : currentView,
                    'fields': getAvailableFields(currentView),
                    'data'  : data
                });
            }, 0);
        });
    }
    $(window).bind('changeview', processView);


    // Returns a list of field names for a given data set.
    function getAvailableFields(view) {
        var metric = view.metric,
            range = normalizeRange(view.range),
            start = range.start,
            end = range.end,
            ds,
            row,
            numRows = 0,
            fields = {};

        // Non-breakdwon metrics only have one field.
        if (!(metric in breakdownMetrics)) return ["count"];

        ds = dataStore[metric];
        if (!ds) throw "Expected metric with valid data!";

        // Locate all unique fields.
        forEachISODate(range, '1 day', ds, function(row) {
            if (row) {
                row = (metric == 'apps') ? collapseVersions(row, 1) : row;
                _.each(row.data, function(v, k) {
                    fields[k] = fields[k] ? fields[k] + v : v;
                });
                _.extend(fields, row.data);
            }
        }, this);

        // sort the fields, make them proper field identifiers, and return.
        return _.map(
            _.sortBy(
                _.keys(fields),
                function (f) {
                    return -fields[f];
                }
            ),
            function(f) {
                return "data|" + f;
            }
        );
    }


    // getDataRange: ensures we have all the data from the server we need,
    // and queues up requests to the server if the requested data is outside
    // the range currently stored locally. Once all server requests return,
    // we move on.
    function getDataRange(view) {
        dbg("enter getDataRange", view.metric);
        var range = normalizeRange(view.range),
            metric = view.metric,
            ds = dataStore[metric],
            reqs = [],
            $def = $.Deferred();

        function finished() {
            var ds = dataStore[metric],
                ret = {}, row, firstIndex;
            if (ds) {
                forEachISODate(range, '1 day', ds, function(row, date) {
                    var d = date.iso();
                    if (row) {
                        if (!firstIndex) firstIndex = d;
                        ret[d] = (metric == 'apps') ? collapseVersions(ds[d], 1) : ds[d];
                    }
                }, this);
                if (_.isEmpty(ret)) {
                    ret.empty = true;
                } else {
                    ret.firstIndex = firstIndex;
                    ret = groupData(ret, view);
                    ret.metric = metric;
                }
                $def.resolve(ret);
            } else {
                $def.fail({ empty : true });
            }
        }

        if (ds) {
            dbg("range", range.start.iso(), range.end.iso());
            if (ds.maxdate < range.end.iso()) {
                reqs.push(fetchData(metric, Date.iso(ds.maxdate), range.end));
            }
            if (ds.mindate > range.start.iso()) {
                reqs.push(fetchData(metric, range.start, Date.iso(ds.mindate)));
            }
        } else {
            reqs.push(fetchData(metric, range.start, range.end));
        }

        $.when.apply(null, reqs).then(finished);
        return $def;
    }


    // Aggregate data based on view's `group` setting.
    function groupData(data, view) {
        var metric = view.metric,
            range = normalizeRange(view.range),
            group = view.group || 'day',
            groupedData = {};
        // if grouping is by day, do nothing.
        if (group == 'day') return data;
        var groupKey = false,
            groupVal = false,
            groupCount = 0,
            d, row, firstIndex;

        if (group == 'all') {
            groupKey = firstIndex = range.start.iso();
            groupCount = 0;
            groupVal = {
                date: groupKey,
                count: 0,
                data: {},
                empty: true
            };
        }
        
        function performAggregation() {
            // we drop the some days of data from the result set
            // if they are not a complete grouping.
            if (groupKey && groupVal && !groupVal.empty) {
                // average `count` for mean metrics
                if (metricTypes[metric] == 'mean') {
                    groupVal.count /= groupCount;
                }
                if (!firstIndex) firstIndex = groupKey;
                // overview gets special treatment. Only average ADUs.
                if (metric == "overview") {
                    groupVal.data.updates /= groupCount;
                } else if (metric in breakdownMetrics) {
                    // average for mean metrics.
                    _.each(groupVal.data, function(val, field) {
                        if (metricTypes[metric] == 'mean') {
                            groupVal.data[field] /= groupCount;
                        }
                    });
                }
                groupedData[groupKey] = groupVal;
            }
        }

        // big loop!
        forEachISODate(range, '1 day', data, function(row, d) {
            // Here's where grouping points are caluculated.
            if ((group == 'week' && d.getDay() === 0) ||
                (group == 'month' && d.getDate() == 1)) {

                performAggregation();
                // set the new group date to the current iteration.
                groupKey = d.iso();
                // reset our aggregates.
                groupCount = 0;
                groupVal = {
                    date: groupKey,
                    count: 0,
                    data: {},
                    empty: true
                };
            }
            // add the current row to our aggregates.
            if (row && groupVal) {
                groupVal.empty = false;
                groupVal.count += row.count;
                if (metric in breakdownMetrics) {
                    _.each(row.data, function(val, field) {
                        if (!groupVal.data[field]) {
                            groupVal.data[field] = 0;
                        }
                        groupVal.data[field] += val;
                    });
                }
            }
            groupCount++;
        }, this);
        if (group == 'all') performAggregation();
        groupedData.firstIndex = firstIndex;
        return groupedData;
    }


    // The beef. Negotiates with the server for data.
    function fetchData(metric, start, end) {
        var seriesStart = start,
            seriesEnd = end,
            $def = $.Deferred();

        var seriesURLStart = Highcharts.dateFormat('%Y%m%d', seriesStart),
            seriesURLEnd = Highcharts.dateFormat('%Y%m%d', seriesEnd),
            seriesURL = baseURL + ([metric,'day',seriesURLStart,seriesURLEnd]).join('-') + '.json';

        dbg("GET", seriesURLStart, seriesURLEnd);

        $.ajax({ url:       seriesURL,
                 dataType:  'text',
                 success:   fetchHandler,
                 error:     errorHandler });

        function errorHandler() {
            $def.fail();
        }

        function fetchHandler(raw_data, status, xhr) {
            var maxdate = '1970-01-01',
                mindate = (new Date()).iso();

            if (xhr.status == 200) {

                if (!dataStore[metric]) {
                    dataStore[metric] = {
                        mindate : (new Date()).iso(),
                        maxdate : '1970-01-01'
                    };
                }

                var ds = dataStore[metric],
                    data = JSON.parse(raw_data);

                var i, datekey;
                for (i=0; i<data.length; i++) {
                    datekey = data[i].date;
                    maxdate = String.max(datekey, maxdate);
                    mindate = String.min(datekey, mindate);
                    ds[datekey] = data[i];
                }
                ds.maxdate = String.max(maxdate, ds.maxdate);
                ds.mindate = String.min(mindate, ds.mindate);
                clearTimeout(writeInterval);
                writeInterval = setTimeout(writeLocalStorage, 1000);
                $def.resolve();

            } else if (xhr.status == 202) { //Handle a successful fetch but with no reponse

                var retry_delay = 30000;

                if (xhr.getResponseHeader("Retry-After")) {
                    retry_delay = parseInt(xhr.getResponseHeader("Retry-After"), 10) * 1000;
                }

                setTimeout(function () {
                    fetchData(metric, start, end, callback);
                }, retry_delay);

            }
        }
        return $def;
    }


    // Rounds application version strings to a given precision.
    // Passing `0` will truncate versions entirely.
    function collapseVersions(row, precision) {
        var out = {
                count   : row.count,
                date    : row.date,
                end     : row.end
            },
            set,
            ver,
            key,
            apps    = row.data,
            ret     = {};

        for (var i in apps) {
            if (apps.hasOwnProperty(i)) {
                set = apps[i];
                for (ver in set) {
                    key = i + '_' + ver.split('.').slice(0,precision).join('.');
                    if (!(key in ret)) {
                        ret[key] = 0;
                    }
                    var v = parseFloat(set[ver]);
                    ret[key] += v;
                }
            }
        }
        out.data = ret;
        return out;
    }


    // Takes a data row and a field identifier and returns the value.
    function getField(row, field) {
        var parts   = field.split('|'),
            val     = row;

        // give up if the row is falsy.
        if (!val) return null;
        // drill into the row object for a nested key.
        // `data|api` means row['data']['api']
        for (var i = 0; i < parts.length; i++) {
            val = val[parts[i]];
            if (!val) {
                return null;
            }
        }

        return val;
    }


    function getPrettyName(metric, field) {
        var parts = field.split('_'),
            key = parts[0];
        parts = parts.slice(1);

        if (metric in csv_keys) {
            if (key in csv_keys[metric]) {
                return csv_keys[metric][key] + ' ' + parts.join(' ');
            }
        }
        return field;
    }


    // Expose some functionality to the z.StatsManager api.
    return {
        'getDataRange'      : getDataRange,
        'fetchData'         : fetchData,
        'dataStore'         : dataStore,
        'getPrettyName'     : getPrettyName,
        'getField'          : getField,
        'clearLocalStorage' : clearLocalStorage,
        'getAvailableFields': getAvailableFields,
        'getCurrentView'    : function() { return currentView; }
    };
})();