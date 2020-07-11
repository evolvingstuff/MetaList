"use strict";

let $visualize_numeric = (function() {

    let processingInstance = null;

	function open_dialog(callback) {
        let filtered_items = $model.getFilteredItems();
        let data_streams = {};
        let keys = [];
        let max_in_a_stream = 0;
        for (let item of filtered_items) {
            for (let subitem of item.subitems) {
                if (subitem._include !== 1) {
                    continue;
                }
                if (subitem._attribute_tags !== undefined && subitem._attribute_tags.length > 0) {
                    for (let tag of subitem._attribute_tags) {
                        let parts = tag.split("=");
                        let name = parts[0];
                        let val = parts[1];
                        if (v.isNumeric(val) === false) {
                            continue;
                        }
                        if (data_streams[name] === undefined) {
                            data_streams[name] = [];
                            keys.push({"name":name, "count":0});
                        }
                        let date = new Date(item.timestamp);
                        date.setMilliseconds(0);
                        date.setSeconds(0);
                        date.setMinutes(0);
                        date.setHours(0);
                        let adjusted_timestamp = new Date(date).getTime();
                        data_streams[name].push({"value":val, "timestamp":adjusted_timestamp});
                        max_in_a_stream = Math.max(max_in_a_stream, data_streams[name].length);
                        keys.filter(key => key.name === name)[0].count += 1;
                    }
                }
            }
        }

        if (max_in_a_stream === 0) {
            alert('Insufficient numeric data in view for visualization');
            callback();
            return;
        }

        function updateSelection(unit) {
            
            data_streams[unit].sort(function(a, b) {
                return a.timestamp - b.timestamp;
            });

            let timestamps = [];
            for (let item of data_streams[unit]) {
                if (timestamps.includes(item.timestamp) === false) {
                    timestamps.push(item.timestamp);
                }
            }
            let grouped = [];
            for (let timestamp of timestamps) {
                let obj = {"value":0, "timestamp": timestamp};
                for (let i = 0; i < data_streams[unit].length; i++) {
                    if (data_streams[unit][i].timestamp === timestamp) {
                        obj.value += parseFloat(data_streams[unit][i].value);
                    }
                }
                grouped.push(obj);
            }

            let add_to_end = false;

            let max_timestamp = 0;
            let max_value = -10000000;
            for (let entry of grouped) {
                max_timestamp = Math.max(max_timestamp, entry.timestamp);
                max_value = Math.max(max_value, entry.value);
            }
            let min_timestamp = max_timestamp;
            let min_value = max_value;
            for (let entry of grouped) {
                min_timestamp = Math.min(min_timestamp, entry.timestamp);
                min_value = Math.min(min_value, entry.value);
            }

            max_timestamp += 86400000; //add a day to end for proper width

            function sketchProc(processing) {

               processing.setup = function() {
                 processing.size(750, 250);
               }

               processing.draw = function() {

                processing.background(25);

                let x1 = 0;
                let x2 = 0;
                let y1 = 0;
                let y2 = 0;
                let W = processing.width;
                let H = processing.height;

                //TODO: maybe refactor these two parts into a single function
                let accumulator = 0;
                let prior_timestamp = 0;
                for (let i = 0; i < grouped.length; i++) {

                    let xa_blend = 0;
                    let ya_blend = 0;
                    let xb_blend = 0;
                    let yb_blend = 0;

                    if (grouped.length > 1) {
                        if (i === grouped.length-1) {
                            break;
                        }
                        let a = grouped[i];
                        let b = grouped[i+1];
                        xa_blend = (a.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                        ya_blend = (a.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                        xb_blend = (b.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                        yb_blend = (b.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    }
                    else {
                        xa_blend = 0.0;
                        xb_blend = 1.0;
                        ya_blend = (grouped[i].value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                        yb_blend = ya_blend;
                    }

                    let padW_left = 10;
                    let padW_right = 10;
                    let padH_top = 25;
                    let padH_bottom = 5;
                    x1 = xa_blend*(W-padW_left-padW_right)+padW_left;
                    x2 = xb_blend*(W-padW_left-padW_right)+padW_left;
                    y1 = (1-ya_blend)*(H-padH_top-padH_bottom)+padH_top;
                    y2 = (1-yb_blend)*(H-padH_top-padH_bottom)+padH_top;

                    processing.stroke(0, 75, 0);
                    processing.fill(0, 75, 0);
                    processing.strokeWeight(1.0);
                    processing.rect(x1, y1, x2-x1, H-y1);
                    processing.stroke(0, 120, 0);
                    processing.line(x1, y1, x1, H);
                }
                if (grouped.length > 1 && add_to_end) {
                    processing.rect(x2, y2, W-x2, H-y2);
                }

                for (let i = 0; i < grouped.length; i++) {

                    let xa_blend = 0;
                    let ya_blend = 0;
                    let xb_blend = 0;
                    let yb_blend = 0;

                    if (grouped.length > 1) {
                        if (i === grouped.length-1) {
                            break;
                        }
                        let a = grouped[i];
                        let b = grouped[i+1];
                        xa_blend = (a.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                        ya_blend = (a.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                        xb_blend = (b.timestamp - min_timestamp) / (max_timestamp - min_timestamp);
                        yb_blend = (b.value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                    }
                    else {
                        xa_blend = 0.0;
                        xb_blend = 1.0;
                        ya_blend = (grouped[i].value - Math.min(0, min_value)) / (max_value - Math.min(0, min_value));
                        yb_blend = ya_blend;
                    }
                    
                    let padW_left = 10;
                    let padW_right = 10;
                    let padH_top = 25;
                    let padH_bottom = 5;
                    x1 = xa_blend*(W-padW_left-padW_right)+padW_left;
                    x2 = xb_blend*(W-padW_left-padW_right)+padW_left;
                    y1 = (1-ya_blend)*(H-padH_top-padH_bottom)+padH_top;
                    y2 = (1-yb_blend)*(H-padH_top-padH_bottom)+padH_top;

                    processing.stroke(0, 250, 0);
                    processing.strokeWeight(2);
                    processing.line(x1, y1, x2, y1);
                    processing.line(x2, y1, x2, y2);
                }
                if (grouped.length > 1 && add_to_end) {
                    processing.line(x2, y2, W, y2);
                }
                this.noLoop();
               };
             }

            let canvas = document.getElementById("canvas-numeric");
            processingInstance = new Processing(canvas, sketchProc);
        }

        let options = '';
        for (let key of keys.sort((a, b) => b.count - a.count)) {
            options += "<option value='"+key.name+"'>"+key.name+" ("+key.count+")</option>";
        }

        picoModal({
            content: 
                "<p style='font-weight:bold; margin:10px;'>Numeric Data Visualizer</p>" +
                "<div style='margin:10px;'>" +
                "<select id='sel_visualization_units'>" + options + "</select>" +
                "<br>" +
                "<br>" +
                "<canvas id='canvas-numeric'> </canvas>" +
                "<br>" +
                "<br>" +
                "<button class='ok'>Okay</button>" +
                "</div>",
            closeButton: false
        }).afterCreate(modal => {
            $('#sel_visualization_units').on('change', function(e) {
                let unit = $(e.currentTarget).val();
                updateSelection(unit);
            });
            modal.modalElem().addEventListener("click", evt => {
                if (evt.target && evt.target.matches(".ok")) {
                    modal.close();
                }
            });
        }).afterShow(modal => {
            let unit = $('#sel_visualization_units').val();
            updateSelection(unit);
        }).afterClose((modal, event) => {
            modal.destroy();
            callback();
        }).show();
	}

	return {
		open_dialog: open_dialog
	}
})();