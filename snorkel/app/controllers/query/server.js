"use strict";


console.log("LOADING QUERY CONTROLLER");

var querystring = require("querystring");
var http = require("http");
var async = require("async");
var url = require("url");
var $ = require("cheerio");
var Hashids = require("hashids"),
    hashids = new Hashids("keyboard cat");


var config = require_core("server/config");
var context = require_core("server/context");
var controller = require_core("server/controller");
var db = require_core("server/db");
var page = require_core("server/page");
var bridge = require_core("server/bridge");
var template = require_core("server/template");

var auth = require_app("server/auth");
var backend = require_app("server/backend");
var metadata = require_app("server/metadata");
var Sample = require_app("server/sample");
var view = require_app("controllers/query/view");
var queries = require_app("server/queries");
var dashboard_controller = require_app("controllers/dashboard/server");

var strtotime = require_vendor("strtotime");

var __results_id = 0;

var value_of = controller.value_of,
    array_of = controller.array_of;




function fuzzy_time(time_str, now, delta) {
  now = now || Date.now();
  var pm = time_str.match("pm");
  time_str = time_str.replace(/(am|pm)/, "");

  var time_val = strtotime(time_str, now / 1000) * 1000;
  if (!time_val) {
    time_val = strtotime(new Date(now).toDateString() + " " + time_str, now / 1000) * 1000;
    if (pm) {
      // Add twelve hours if we see pm string
      time_val += 1000 * 60 * 60 * 12;
    }
  }

  var ret = time_val;
  if (delta) {
    var epoch = +(new Date());
    return ret - epoch;
  }

  return ret;

}

function estimate_time_buckets(query_interval, buckets) {
  var best_bucket_count = buckets || 1000;
  var min_intervals = [ 5, 10, 30, 60, 120, 360, 720 ];
  var i, interval_ms;


  for (i = 0; i < min_intervals.length; i++) {
    var interval = min_intervals[i] * 60 * 1000;
    if (query_interval / interval < best_bucket_count) {
      interval_ms = min_intervals[i] * 60;
      break;
    }
  }

  return interval_ms;
}

function marshall_query(form_data) {
  var query_data = {};

  query_data.dims = array_of(form_data, 'group_by', ["browser"]);
  query_data.view = value_of(form_data, 'view', 'overview');
  query_data.baseview = value_of(form_data, 'baseview', query_data.view);
  query_data.time_field = value_of(form_data, 'time_field', 'time');

  var limit = 100;
  if (query_data.view === 'samples') {
    limit = 100;
  }

  if (query_data.view === 'overview') {
    limit = 500;
  }

  query_data.limit = value_of(form_data, 'max_results', limit);
  if (_.isString(query_data.limit)) {
    query_data.limit = parseInt(query_data.limit, 10);
  }


  query_data.table = value_of(form_data, 'table');
  query_data.sort_by = value_of(form_data, 'sort_by', "count");
  query_data.stacking = value_of(form_data, 'stacking', 'normal');

  var start_str_ms = value_of(form_data, 'start', '-1 hour');
  var end_str_ms = value_of(form_data, 'end', 'now');
  var now = Date.now();

  query_data.field_two = value_of(form_data, 'field_two');

  // Now we should round the start and end to the time bucket
  query_data.start_ms = fuzzy_time(start_str_ms, now);
  query_data.end_ms = fuzzy_time(end_str_ms, now);

  var query_interval = Math.abs(query_data.end_ms - query_data.start_ms);
  var time_bucket = parseInt(value_of(form_data, 'time_bucket'), 10);
  if (!time_bucket) {
    time_bucket = estimate_time_buckets(query_interval, 800);
  }

  if (time_bucket) {
    // Have to adjust the interval if there is a time bucket
    query_data.start_ms = (Math.round(query_data.start_ms / 1000 / time_bucket) - 1) * time_bucket * 1000;
    query_data.end_ms = (Math.ceil(query_data.end_ms / 1000 / time_bucket) + 1) * time_bucket * 1000;

  }

  query_data.end_str = end_str_ms;
  query_data.start_str = start_str_ms;

  query_data.start_date = new Date(query_data.start_ms);
  query_data.end_date = new Date(query_data.end_ms);
  query_data.weight_col = value_of(form_data, 'weight_col');

  console.log("Looking for time between", query_data.start_date, "and", query_data.end_date);

  var compare_delta = value_of(form_data, 'compare');
  if (compare_delta) {
    query_data.compare_delta = fuzzy_time(compare_delta, null, true);
    query_data.compare_str = compare_delta;
  }


  var hist_bucket = parseInt(value_of(form_data, 'hist_bucket', null), 10);

  // TODO: have views take more part in augmenting query data?
  query_data.hist_bucket = hist_bucket;
  query_data.time_bucket = time_bucket;

  var aggs = [];
  var agg = value_of(form_data, 'agg', 'avg');
  var fields = array_of(form_data, 'field');
  var fieldset = array_of(form_data, 'fieldset');

  query_data.cols = [];
  var use_fields;

  // TODO: Dist only accepts one field at a time, but this needs to be better
  // encapsulated
  if (fieldset.length && query_data.view !== "dist") {
    use_fields = fieldset;
  } else if (fields.length) {
    use_fields = fields;
    if (query_data.field_two) {
      use_fields.push(query_data.field_two);
    }
  } else {
    console.log("Warning: no fields found for query");
    use_fields = [ ];
    agg = "$count";
  }

  _.each(use_fields, function(field) {
    query_data.cols.push(field);

    aggs.push({
      arg: field,
      type: agg.toUpperCase()
    });
  });

  var input_filters = JSON.parse(value_of(form_data, 'filters', '{}'));

  function parse_filters(form_filters, use_falsey) {
    var filters = {};
    var now = Date.now();
    // I don't know the field types over here. Oops.
    _.each(form_filters, function(filter) {
      var field = filter.shift();
      var op = filter.shift();
      var val = filter.shift();

      // TODO: come back ehere and fix logic for when to sue filters and not.
      if (!val && !use_falsey) {
        return;
      }

      if (field.match(/integer/)) {
        var parsed_val = parseInt(val, 10);

        if (!_.isNumber(parsed_val) || _.isNaN(parsed_val)) {
          parsed_val = fuzzy_time(val, now);
          val = parsed_val;
        } else {
          val = parsed_val;
        }

        if (!_.isNumber(val)) {
          return;
        }
      }

      // ^((?!query).)*$
      // do some preproductions :-)
      // TODO: move operation preprocessing to lower in the stack?
      if (op === "$regexv") {
        val = "^((?!" + val + ").)*$";
        op = "$regex";
      }

      // there is no real support for $eq in mongo, instead using $all. even though
      // its more SFy.
      if (op === "$eq") {
        val = [val];
        op = "$all";
      }

      // For $nin and $in, try JSON first, then regular string second
      if (op === "$nin" || op === "$in" || op === "$all") {
        if (_.isString(val)) {
          try {
            val = JSON.parse(val);
          } catch(e) {
            val = val.split(',');
          }
        }

        if (!_.isArray(val)) {
          val = [val];
        }
      }

      filters[field] = filters[field] || { conditions: [] };
      filters[field].conditions.push({ op: op, value: val });
      filters[field].column = field;
    });

    var ret = [];
    _.each(filters, function(filter) {
      ret.push(filter);
    });

    return ret;
  }

  if (input_filters.query) {
    query_data.filters = parse_filters(input_filters.query, false /* dont consider empty filters */);
  }

  if (input_filters.compare) {
    var compare_filters = parse_filters(input_filters.compare, true /* allow empty filters */);
    if (compare_filters.length) {
      query_data.compare_filters = compare_filters;
    }
  }

  query_data.agg = agg;

  return query_data;
}

function run_query(table_name, pipeline, query_type, do_weighting, cb) {
  console.log("Running query on", table_name);
  backend.run(table_name, pipeline, do_weighting, function(err, data) { cb(err, data); });
}


var empty_str = "";
function load_saved_query(conditions, cb) {
  var collection = db.get("query", "results");
  cb = context.wrap(cb);

  collection.find(conditions, context.wrap(function(err, cur) {
    if (err || !cur) {
      return cb(null);
    }

    cur.limit(1).sort({ updated: -1 });

    cur.toArray(context.wrap(function(err, arr) {
      if (err) {
        console.log(err);
        return cb(null);
      }

      var obj = arr.pop();
      if (!obj) {
        return cb(null);

      }

      var input_view = _.find(obj.input, function(r) {
        return r.name === "view";
      });

      if (!input_view) {
        obj.input.push({name: "view", value: obj.parsed.view});
      }

      return cb(obj);
    }));
  }));
}

function get_index() {
  console.log("GETTING INDEX");

  if (controller.require_https()) { return; }

  var table = context("req").query.table || backend.get_default_table();
  if (_.isArray(table)) {
    table = table.pop();
  }
  console.log("GOT DEFAULT TABLE");

  context("query_table", table);
  context("title", "snorkel");

  bridge.controller("query", "set_table", table);

  console.log("SETTING TABLE");
  function render_query_content() {

    return page.async(function(flush) {
      var client_id = context("req").query.client_id || context("req").query.c;
      var hashid = context("req").query.hashid || context("req").query.h;
      var empty_str = template.partial("query/content.html.erb");
      var conditions = { };

      if (hashid) {
        conditions.hashid = hashid;
      } else if (client_id) {
        conditions.clientid = client_id;
      } else {
        bridge.controller("query", "run_startup_query");
        return flush(empty_str);
      }

      load_saved_query(conditions, function(obj) {
        if (obj) {
          bridge.controller("query", "load_saved_query", obj);
        } else {
          bridge.controller("query", "run_startup_query");
        }

        flush(empty_str);
      });


    })();
  }

  function render_query_sidebar() {
    var controls = view.get_controls(),
        filters = view.get_filters(),
        stats = view.get_stats();

    function render_button_bar(aux_buttons) {
      var go_button = $C("button", {
        name: "Go",
        delegate: { "click" : "go_clicked" },
        classes: "go_button btn-primary"
      });

      if (!aux_buttons) {
        go_button.$el.addClass("mtm");
        return go_button.toString();
      }

      var barEl = $("<div class='button-bar clearfix mbl'/>");
      var save_button = $C("button", {
        name: "",
        delegate: { "click" : "save_clicked" },
        classes: "save_button mll btn"
      });
      save_button.set_title("Save Query");

      var share_button = $C("button", {
        name: "",
        delegate: { "click" : "share_clicked" },
        classes: "share_button mll btn"
      });
      share_button.set_title("Share Query");

      var dash_button = $C("button", {
        name: "",
        delegate: { "click" : "dashboard_clicked" },
        classes: "dash_button mll btn"
      });
      dash_button.set_title("Add query to dashboard");

      var download_button = $C("button", {
        name: "",
        delegate: { "click" : "download_clicked" },
        classes: "download_button mll btn"
      });
      download_button.set_title("Download raw query results");


      save_button.$el.append($("<i class='icon-star' />"));
      share_button.$el.append($("<i class='icon-share' />"));
      download_button.$el.append($("<i class='icon-download' />"));
      dash_button.$el.append($("<i class='icon-plus' />"));

      barEl.append(go_button.toString());
      var leftSideEl = $("<div class='mrl aux_buttons' />");
      leftSideEl.append(download_button.toString());
      leftSideEl.append(share_button.toString());
      leftSideEl.append(dash_button.toString());
      leftSideEl.append(save_button.toString());
      barEl.append(leftSideEl);

      return barEl.toString();
    }

    function wrap_str(str) {
      return function() {
        return str;
      };
    }

    var editEl = $("<a>Dataset Settings</a>")
      .attr('href', '/datasets/edit?table=' +  table)
      .attr('target', '_blank');

    var edit_link = editEl.toString();

    var render_dashboards = page.async(function(flush) {
      dashboard_controller.get_dashboards(null, function(dashes) {
        bridge.controller("query", "set_dashboards", dashes);
      });
      flush("");
    });

    return template.partial("query/sidebar.html.erb", {
      render_controls: wrap_str(controls),
      render_filters: wrap_str(filters),
      render_stats: wrap_str(stats),
      render_edit_link: wrap_str(edit_link),
      render_go_button: render_button_bar,
      render_aux_button: render_button_bar,
      render_dashboards: render_dashboards
    });
  }

  var header_str = template.render("helpers/header.html.erb", {
    tabs: function() {
      return $("<div>")
        .html(view.table_selector()())
        .html();
    }
  });

  console.log("READ TEMPLATE STRING");

  var template_str = template.render("controllers/query.html.erb", {
      render_query_content: render_query_content,
      render_query_sidebar: render_query_sidebar
    });


  page.render({content: template_str, header: header_str});

}

function post_bounce() {
  if (controller.require_https()) { return; }
  var req = context("req");
  var res = context("res");

  var results = req.body.data || "";
  res.setHeader('Content-Length', results.length);
  res.write(results, "binary");
  res.end();
}

function get_download() {
  if (controller.require_https()) { return; }
  var client_id = context("req").query.client_id || context("req").query.c;
  var hashid = context("req").query.hashid || context("req").query.h;
  var conditions = { };
  var now = parseInt(Date.now() / 1000, 10);
  var query_id = "api/" + now;
  var req = context("req");
  var res = context("res");



  function use_saved_query() {
    load_saved_query(conditions, function(query) {
      if (query) {
        var results = JSON.stringify(query.results);
        res.setHeader('Content-Length', results.length);
        res.write(results, 'binary');
        res.end();
      }
    });
  }

  if (hashid) {
    conditions.hashid = hashid;
    use_saved_query();
  } else if (client_id) {
    conditions.clientid = client_id;
    use_saved_query();
  } else { // running a new query
    var query_form_data = [];
    _.each(context("req").query, function(v, k) {
      if (_.isArray(v)) {
        _.each(v, function(vv) {
          query_form_data.push({ name: k, value: vv });
        });
      } else {
        query_form_data.push({ name: k, value: v });
      }
    });

    var query_data = marshall_query(query_form_data);
    handle_new_query(query_id, query_data, null, function(results) {
      results = JSON.stringify(results);
      res.setHeader('Content-Length', results.length);
      res.write(results, 'binary');
      res.end();
    });
  }

}


function log_query(query_data, user) {
  var sample_data = {
    integer: {
      start_time: query_data.start_ms,
      end_time: query_data.end_ms
    },

    string: {
      weight_col: query_data.weight_col || "unspecified",
      view: query_data.view,
      table: query_data.table,
      start: (query_data.start_str || "unspecified"),
      end: (query_data.end_str || "unspecified"),
      // This relies on behaviors in server/auth
      user: user
    },
    set: {
      cols: query_data.cols || [query_data.col],
      dims: query_data.dims
    }

  };

  var sample = Sample.create(sample_data)
    .set_dataset("snorkle")
    .set_subset("queries");

  return sample;
}

function handle_new_query_with_meta(meta, query_id, query_data, socket, done) {
  var pipeline = backend.prep_pipeline(query_data, meta);
  var compare_pipeline;
  var compare_data;


  if (query_data.compare_delta || query_data.compare_filters) {
    compare_data = _.clone(query_data);

    if (query_data.compare_delta) {
      compare_data.start_ms = query_data.start_ms + query_data.compare_delta;
      compare_data.end_ms = query_data.end_ms + query_data.compare_delta;
    }

    if (query_data.compare_filters) {
      // TODO: check these dont look the same as regular filters
      compare_data.filters = query_data.compare_filters;
    }

    compare_pipeline = backend.prep_pipeline(compare_data, meta);
    query_data.compare_mode = true;
  }


  var user = "anon";
  if (socket && socket.manager.__user) {
    user = socket.manager.__user.username || "__awkward__";
  }

  var sample = log_query(query_data, user);

  var start = Date.now();

  var results = {};

  var weight_cols = false;
  // TODO: better encode when views need post processing
  var sample_views = backend.SAMPLE_VIEWS;
  if (query_data.weight_col && !backend.SAMPLE_VIEWS[query_data.view]) {
    weight_cols = true;
  }

  function sort_data(data, col) {
    return _.sortBy(data, function(r) {
      return r[col] || 0;
    }).reverse();
  }

  var jobs = [
    function(cb) {
      // how to execute these properly?
      run_query(query_data.table, pipeline, '', weight_cols, function(err, data) {
        query_data.id = query_id;
        var query_results = { parsed: query_data, results: data, error: err, id: query_id, created: start};

        if (socket) {
          socket.emit("query_results", query_results);
        }

        results.query = query_results;
        sample.add_integer("query_duration", Date.now() - start);

        cb();
      });
    }
  ];

  if (compare_pipeline) {
    jobs.push(function(cb) {
      run_query(query_data.table, compare_pipeline, 'comparison', weight_cols, function(err, data) {
        compare_data.id = query_id;
        var compare_results = { parsed: compare_data, results: data, error: err, id: query_id, created: start};

        if (socket) {
          socket.emit("compare_results", compare_results);
        }
        sample.add_integer("compare_duration", Date.now() - start);
        results.compare = compare_results;

        cb();
      });
    });
  }

  async.parallel(jobs, function(err, cb) {
    sample
      .flush();

    done(results);
  });
}

function handle_new_query(query_id, query_data, socket, done) {
  metadata.get(query_data.table, function(meta) {
    var column_casts = [];
    _.each(meta.metadata.columns, function(col) {
      if (col.cast_str) {
        console.log("CASTING ", col);
        column_casts.push({
          name: col.name,
          to_type: col.cast_str,
          from_type: col.type_str
        });
      }
    });

    query_data.cast_cols = column_casts;
    handle_new_query_with_meta(meta, query_id, query_data, socket, done);
  });
}

function save_query(socket, query, name, description) {
  var conditions = {};
  if (!query.hashid) {
    return;
  }

  if (query.hashid) { conditions.hashid = query.hashid; }

  console.log("Saving query", conditions);
  queries.get_saved_query(conditions, function(err, obj) {
    if (err || !obj) {
      console.log("FAILED TO SAVE", conditions);
      return;
    }

    obj.saved = true;
    obj.title = name;
    obj.description = description;
    obj.updated = +Date.now();

    var collection = db.get("query", "results");
    collection.update({_id: obj._id}, obj);

    socket.emit("saved_query", obj);
  });
}

function refresh_query(form_data, __id, socket, cb) {
  var collection = db.get("query", "results");
  // save results to db
  if (!form_data || !form_data.hashid) {
    return;
  }
  var user_id = socket.manager.__user.id || parseInt(Math.random() * 10000, 10);
  var user_name = socket.manager.__user.username;

  queries.get_saved_query({ hashid: form_data.hashid}, function(err, saved_query) {
    if (!saved_query) {
      return;
    }


    var now = parseInt(Date.now() / 1000, 10);
    var query_id = user_id + "/" + __id + "/" + now;
    var hashed_id = form_data.hashid;

    var since_last_refresh = now - ((saved_query.updated || saved_query.created) / 1000);
    var cache_time = saved_query.cache || 60;

    var needs_refresh = cache_time < since_last_refresh;
    if (form_data.intermediate || !needs_refresh) {
      console.log("Sending cached query to dashboard", saved_query.hashid);
      socket.emit("query_results", saved_query.results.query);
      if (saved_query.results.compare) {
        socket.emit("compare_results", saved_query.results.compare);
      }

      socket.emit("query_id", { client_id: saved_query.clientid, server_id: saved_query.hashid});
    }

    if (!needs_refresh) {
      return;
    }

    saved_query.parsed = marshall_query(saved_query.input);

    handle_new_query(query_id, saved_query.parsed, socket, function(results) {
      // save results to db
      var new_query = _.clone(saved_query);
      _.extend(new_query, {
        created: saved_query.created,
        updated: +Date.now(),
        parsed: saved_query.parsed,
        results: results,
        hashid: form_data.hashid,
        clientid: query_id
      });

      delete new_query._id;

      collection.insert(new_query, function(err, item) {
        if (err) { console.log("Error saving query results:", err); }
        socket.emit("query_id", { client_id: query_id, server_id: hashed_id});
      });
    });
  });

}

function load_rss(table, cb) {
  metadata.get(table, function(meta) {
    var feed_url = meta.metadata.rss_feed || (config.rss_feed && config.rss_feed.url);

    if (!feed_url) {
      return cb();
    }

    http.get(feed_url, function(res) {
      var data = "";
      res.on('data', function(chunk) {
        data += chunk.toString();
      });

      res.on('end', function() {
        cb(data);
      });
    });

  });
}

function load_annotations(table, cb) {
  var collection = db.get("dataset", "annotations");

  var annotations = {};
  annotations.items = [];
  annotations.rss = [];

  var after = _.after(2, function() {
    cb(annotations);
  });

  collection.find({}, function(err, cur) {
    if (err || !cur) {
      return cb(null);
    }

    cur.toArray(context.wrap(function(err, arr) {
      annotations.items = arr;
      console.log(arr);
      after();
    }));
  });

  load_rss(table, function(items) {
    annotations.rss = items;
    after();
  });
}

module.exports = {
  routes: {
    "" : "index",
    "/saved": "saved",
    "/user" : "user",
    "/dataset" : "dataset",
    "/download" : "download"
  },
  post_routes: {
    "/bounce" : "bounce"
  },

  refresh: refresh_query,
  save: save_query,
  socket: function(socket) {
    var __id = 1;
    var user_id = socket.manager.__user.id || parseInt(Math.random() * 10000, 10);
    var user_name = socket.manager.__user.username;

    socket.on("get_saved_queries", function(dataset) {
      queries.get_saved_for_user(user_name, dataset, function(arr) {
        socket.emit("saved_queries", arr);
      });
    });

    socket.on("get_recent_queries", function(dataset) {
      queries.get_recent_queries_for_user(user_name, dataset, function(arr) {
        socket.emit("recent_queries", arr);
      });
    });

    socket.on("get_shared_queries", function(dataset) {
      queries.get_saved_for_dataset(user_name, dataset, function(arr) {
        socket.emit("shared_queries", arr);
      });
    });

    socket.on("get_past_results", function(hashid, cb) {
      queries.get_past_results(hashid, function(arr) {
        if (cb) {
          cb(hashid, arr);
        } else {
          socket.emit("past_results", hashid, arr);
        }
      });
    });

    socket.on("load_query_data", function(query, cb) {
      queries.get_saved_query(query, function(err, arr) {
        if (!err) {
          cb(arr);
        }
      });
    });


    socket.on("save_query", function(query, name, description) {
      save_query(socket, query, name, description);
    });

    socket.on("delete_query", function(form_data) {
      var collection = db.get("query", "results");
      if (!form_data.hashid) {
        return;
      }

      collection.update(
        { hashid: form_data.hashid, username: user_name},
        { $set: { saved: false }},
        {multi: true});

    });

    socket.on("refresh_query", function(form_data) {
      refresh_query(form_data, __id, socket);
    });

    socket.on("update_portlet", function(portlet) {
      console.log("Updating portlet", portlet);
      dashboard_controller.update_portlet(socket, portlet);
    });

    socket.on("load_rss", load_rss);
    socket.on("load_annotations", load_annotations);

    socket.on("new_query", function(form_data) {
      var now = parseInt(Date.now() / 1000, 10);
      var query_id = user_id + "/" + __id + "/" + now;
      var hashed_id = hashids.encrypt(user_id, __id, now);

      var query_data = marshall_query(form_data);
      socket.emit("query_ack", {
        parsed: query_data, input: form_data, id: query_id, hashid: hashed_id });

      handle_new_query(query_id, query_data, socket, function(results) {
        var collection = db.get("query", "results");
        // save results to db
        collection.insert({
          input: form_data,
          created: +Date.now(),
          updated: +Date.now(),
          parsed: marshall_query(form_data),
          results: results,
          hashid: hashed_id,
          clientid: query_id,
          userid: user_id,
          username: user_name
        }, function(err, item) {
          if (err) { console.log("Error saving query results:", err); }
          socket.emit("query_id", { client_id: query_id, server_id: hashed_id});
        });
      });
    });
  },
  index: auth.require_user(get_index),
  download: function() {
    if (!config.no_api_auth) {
      auth.require_user(get_download)();
    } else {
      get_download();

    }
  },
  bounce: post_bounce,
  load_rss: load_rss,
  load_annotations: load_annotations
};
