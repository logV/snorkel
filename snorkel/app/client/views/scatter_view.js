"use strict";

var helpers = require("app/client/views/helpers");
var presenter = require("app/client/views/presenter");
var SamplesView = require("app/client/views/samples_view");

var ScatterView = SamplesView.extend({
  baseview: helpers.VIEWS.SAMPLES,
  prepare: function(data) {
    return data;
  },

  finalize: function() {
    if (!this.data.results.length) {
      return "No Samples";
    }

    var group_by = this.data.parsed.dims,
        grouped_compare_data,
        grouped_data;

    grouped_data = _.groupBy(this.data.results, function(result) {
        return helpers.result_key(group_by, result);
      });

    this.points = grouped_data;
    if (this.compare_data) {
      grouped_compare_data = _.groupBy(this.compare_data.results,
        function(result) {
          return helpers.row_key(group_by, result);
        });
      this.compare_points = grouped_compare_data;


    }
  },

  render: function() {

    var series = [];
    var field_one = this.data.parsed.cols[0];
    var field_two = this.data.parsed.cols[1];
    var max_x = Number.MIN_SAFE_INTEGER;
    var max_y = Number.MIN_SAFE_INTEGER;
    var min_x = Number.MAX_SAFE_INTEGER;
    var min_y = Number.MAX_SAFE_INTEGER;
    var self = this;

    _.each(this.points, function(point_group, name) {
      var color_str = helpers.get_rgba(name);
      var serie = {
        data: [],
        name: (name || ""),
        color: color_str
      };
      series.push(serie);
      _.each(point_group, function(result) {
        min_x = Math.min(result.integer[field_one], min_x);
        min_y = Math.min(result.integer[field_two], min_y);
        max_x = Math.max(result.integer[field_one], max_x);
        max_y = Math.max(result.integer[field_two], max_y);
        serie.data.push({
          x: result.integer[field_one],
          y: result.integer[field_two],
          result: result
        });
      });
    });

    var options = {
      chart: {
          type: 'scatter',
          zoomType: 'xy',
      },
      legend: { enabled: true },
      xAxis: {
        type: "linear",
        min: min_x,
        max: max_x,
        title: {
          text: presenter.get_field_name(this.table, field_one)
        }
      },
      tooltip: {
      shared: false,
      formatter: function () {
           return '<b>' + this.series.name + '</b><br/>' +
             field_one + ": " + helpers.number_format(this.x) + ' <br/>' +
             field_two + ": " + helpers.number_format(this.y) + '<br/>' +
             '<br /> (click for full sample details)';
         }
       },

      plotOptions: {
        series: {
          fillOpacity: 0.1,
          marker: {
            enabled: true,
          },
          point: {
            events: {
              click: function() {
                var details = "<pre class='sample_details'>" + JSON.stringify(this.result, null, 2) + "</pre>";
                $C("modal", {title: "Sample details", body: details}, function(modal) {
                  modal.show();
                });
              }
            }
          }
        }
      },
      yAxis: {
        min: min_y,
        max: max_y,
        title: {
          text: presenter.get_field_name(this.table, field_two)
        }
      },

      series: series
    };

    var $el = this.$el;
    $C(self.graph_component, {skip_client_init: true}, function(cmp) {
        // There's a little setup cost to highcharts, maybe?
      $el.append(cmp.$el);
      cmp.client(options);
    });

  }
}, {
  icon: "noun/pin.svg"
});

var excludes = helpers.inputs.MULTI_AGG;
SF.trigger("view:add", "scatter",  {
  include: _.difference(
    helpers.STD_INPUTS
      .concat(helpers.inputs.GROUP_BY)
      .concat(helpers.inputs.SINGLE_AGG)
      .concat(helpers.inputs.TWO_FIELDS),
    excludes)
}, ScatterView);
module.exports = ScatterView;
