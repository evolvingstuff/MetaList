'use strict';

function formatDate(item) {
	var d = new Date(item.timestamp);
    var year = '' + d.getFullYear();
    var month = '' + (d.getMonth() + 1);
    var day = '' + d.getDate();
    var hour = '' + d.getHours();
    var minute = '' + d.getMinutes();
    if (month.length < 2) {
        month = '0' + month;
    }
    if (day.length < 2) {
        day = '0' + day;
    }
    if (hour.length < 2) {
        hour = '0' + hour;
    }
    if (minute.length < 2) {
        minute = '0' + minute;
    }
    var formatted_date = year + '-' + month + '-' + day;
    return formatted_date;
}