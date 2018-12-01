'use strict';

function formatDate(item) {
	let d = new Date(item.timestamp);
    let year = '' + d.getFullYear();
    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    let hour = '' + d.getHours();
    let minute = '' + d.getMinutes();
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
    let formatted_date = year + '-' + month + '-' + day;
    return formatted_date;
}

function formatDateAndDOW(item) {
    var weekday = new Array(7);
    weekday[0] =  "Sunday";
    weekday[1] = "Monday";
    weekday[2] = "Tuesday";
    weekday[3] = "Wednesday";
    weekday[4] = "Thursday";
    weekday[5] = "Friday";
    weekday[6] = "Saturday";

    let d = new Date(item.timestamp);
    let year = '' + d.getFullYear();
    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    let hour = '' + d.getHours();
    let minute = '' + d.getMinutes();
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
    let formatted_date = year + '.' + month + '.' + day + ' - ' + weekday[d.getDay()];

    /*
    let now = Date.now();
    let diff = item.timestamp - now;
    let days_diff = diff / (1000*60*60*24);

    if (days_diff < -1) {
        formatted_date += " ("+parseInt(-days_diff)+" days ago)"
    }
    */

    return formatted_date;
}