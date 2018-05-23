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