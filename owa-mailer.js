// Copyright (c) 2018, Tan Hock Woo
//
// Run with: phantomjs owa-mailer.js


// configuration
var config = { 
	domain: '<login domain>', 
	username:'<user id>', 
	password : '<password>',
	url : 'https://<url>/owa/',
	email: '<email address to forward mail to>',
	noreply : '<email address for contacts which are not correctly parsed>',
	timeout : 5000,   // Duration to wait for response from OWA
	refresh : 60000,  // Duration between checks for new mails (milliseconds)
	watchDog: 300000, // Duration between checks to determine if app is  still functioning(milliseconds)
	logLevel: 5
};

var page = require('webpage').create();
var fs = require('fs');
var process = require('child_process');
var system = require('system');

var mailer = '/usr/sbin/sendmail';
var basedir = 'tmp/';
var msgId = 0;
var contacts = {};
var debugMode = false;
var lastActive = Date.now();
var scriptName =  system.args[0].lastIndexOf(fs.separator) > 0 
				? system.args[0].substr(system.args[0].lastIndexOf(fs.separator)) 
				: system.args[0];

// Debugging support
DEBUG = function(str)  { if (debugMode) console.log(str); }
INFO  = function(str)  { if (config.logLevel > 0) console.log(str); }
WARN  = function(str)  { if (config.logLevel > 1) console.log(str); }
ERROR = function(str)  { console.log(str); }

// Force OWA to switch to Light version using a mobile User Agent string
page.settings.userAgent = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Mobile Safari/537.36';
page.loadImages = false;
page.viewportSize = { width: 400, height: 701 };

page.onConsoleMessage = function(msg) {
	INFO('>>' + msg);
};

resetWatchDog = function() {
	lastActive = Date.now();
	fs.write(basedir + scriptName + '.chkpt', lastActive, 'w');
};

watchDogFn = function() {
	var deltaTime = Date.now() - lastActive;
	if (deltaTime > config.watchDog) {
		var lastActiveStr = new Date(lastActive).toString();
		ERROR("Timeout: No activity since " + lastActiveStr);

		var uuid = Date.now() + Math.random().toString(36).substr(2, 10);
		var filename = basedir + uuid + '.txt';

		var mail = '';
		mail += 'To: ' + config.email +'\r\n';
		mail += 'From: ' + config.email + '\r\n';
		mail += 'Date: ' + lastActiveStr + '\r\n';
		mail += 'Subject: OWA Mail Timeout\r\n';
		mail += 'MIME-Version: 1.0\r\n';
		mail += 'Content-Type: text/plain\r\n';
		mail += '\r\nOWA Mail Timeout Since ' + lastActiveStr + '\r\n\r\n';
		fs.write(filename, mail, 'w');

		// send out the email
		var cmdLine = mailer + ' ' + config.email + ' < ' + filename;

		INFO("Executing: " + cmdLine);
		process.execFile('/bin/bash', ['-c', cmdLine], null, 
	                function (err, stdout, stderr) {
				fs.remove(filename);
				phantom.exit();
			}
		);
	}
	else {
		INFO("WatchDog: "  + deltaTime);
	}
	setTimeout(watchDogFn, config.refresh);
};

waitForPage = function(selector, pageName) {
	INFO('Waiting for ' + pageName);

	page.onLoadFinished = null;

	var ready = false;
	var start = Date.now();
	var cur = start;
	while (!ready && cur < start + config.timeout) {
		ready = page.evaluate( 
			function(selector) {
				return document.querySelectorAll(selector).length > 0;
			}, selector 
		);
		cur = Date.now();
	}
	if (!ready) { 
		ERROR('Timeout waiting for ' + pageName);
		page.render(basedir + pageName + '.png');
		fs.write(basedir + pageName + '.html', page.content, 'w'); 
		phantom.exit();
	}

	return true;
};

nextMailFn = function() {
	INFO("Checking for main or mail page...");
	resetWatchDog();

	var whichPage = page.evaluate( 
		function() { 
			if (document.querySelectorAll('.cntnt').length > 0)  return 1;
			if (document.querySelectorAll('div.bdy').length > 0) return 2;
			return 0;
		} 
	);

	if (whichPage == 1) mainPageFn(); else mailPageFn();
};

mailPageFn = function() {
	waitForPage('div.bdy', 'Mail #' + msgId);

	var msg = page.evaluate(
		function(baseurl, noreply, contacts) {

			base64Encode = function(str) {
				var CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
				var out = "", i = 0, len = str.length, c1, c2, c3;
				while (i < len) {
					c1 = str.charCodeAt(i++) & 0xff;
					if (i == len) {
						out += CHARS.charAt(c1 >> 2);
						out += CHARS.charAt((c1 & 0x3) << 4);
						out += "==";
						break;
					}
					c2 = str.charCodeAt(i++);
					if (i == len) {
						out += CHARS.charAt(c1 >> 2);
						out += CHARS.charAt(((c1 & 0x3)<< 4) | ((c2 & 0xF0) >> 4));
						out += CHARS.charAt((c2 & 0xF) << 2);
						out += "=";
						break;
					}
					c3 = str.charCodeAt(i++);
					out += CHARS.charAt(c1 >> 2);
					out += CHARS.charAt(((c1 & 0x3) << 4) | ((c2 & 0xF0) >> 4));
					out += CHARS.charAt(((c2 & 0xF) << 2) | ((c3 & 0xC0) >> 6));
					out += CHARS.charAt(c3 & 0x3F);
					if (i % 900 == 0) out += '\r\n';
			    }
				return out;
			};

			getBinary = function(file){
				var xhr = new XMLHttpRequest();
				xhr.open("GET", file, false);
				xhr.overrideMimeType("text/plain; charset=x-user-defined");
				xhr.send(null);
				return xhr.responseText;
			};

			getUrl = function(elem, baseurl) {
				var lnk = elem.innerText;
				var l = lnk.trim().toLowerCase();
				if (l.indexOf('http://')  === 0 || 
					l.indexOf('https://') === 0 || 
					l.indexOf('ftp://')   === 0 || 
					l.indexOf('ftps://')  === 0 || 
					l.indexOf('mailto:')  === 0) return lnk;
			    
				var url = elem.href;
				var xhr = new XMLHttpRequest();
				xhr.open('GET', url, false);
				xhr.send();
				if (xhr.status === 200) {
					var n0 = xhr.responseText.search("a_sURL =");
					var n1 = xhr.responseText.search("function ldLnk");
					if (n0 > 0 && n1 > 0) {
						var str = xhr.responseText.substr(n0 + 9, n1 - n0 - 9 - 7);
						try {
							lnk = JSON.parse(str);
						}
						catch(e) {							
							// simple replacement
							str = str.substr(1, str.length-1);
							lnk = str.replace(/\\\//g, '\/');
						}
					}
				}
				return lnk; 
			};

			getEmailAddr = function(elem, baseurl, noreply) {
				var addr = elem.innerText +' <' + noreply + '>';
				var matchAddr = elem.innerText.match(/(\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3}))/g);      
				if (matchAddr != null) {
					addr = matchAddr[0];
					if (elem.hasAttribute('class') && elem.getAttribute('class') === 'emadr') {
						addr = elem.innerText.replace(/\[(\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3}))\]/i, '<$1>');
					}
				}
				else if (elem.hasAttribute('id')) {
					var contact = elem.innerText.trim().toLowerCase();
					if (contact in contacts) {
						addr =  elem.innerText + '<' + contacts[contact] + '>';
					}
					else {
						var url = baseurl + '?ae=Item&t=AD.RecipientType.User&id=' + elem.id + '&ctx=1';
						var xhr = new XMLHttpRequest();
						xhr.open('GET', url, false);
						xhr.send();
						if (xhr.status === 200) {
							var n = xhr.responseText.search("Email");
							var s = (n > 0) ? xhr.responseText.substr(n, 300) : "";
							var matchAddr = s.match(/(\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3}))/g);
							if (matchAddr != null) {
								contacts[contact] = matchAddr[0];
								addr = elem.innerText + ' <' + matchAddr[0] +'>';
							}
						}
					}
				}

				// Sanitize email by replacing comma and semi-comma with space
				addr = addr.replace(/[\,\;]/g,' ');
				return addr;
			};

			var result = { 
				from: "",
				to: "",
				cc: "",
				bcc: "",
				date: new Date().toString(),
				subject:"",
				text:"",
				html: "",
				headers: [],
				inlines: [],
				attachments: {}
			};


			var headers = document.querySelectorAll('.msgHd tr .hdtxt,.hdtxnr');
			var content = document.querySelector("div.bdy");
			var attachments = document.querySelectorAll('#lnkAtmt');
			var infoHeaders = document.querySelectorAll('div#dvInf div');
			var links   = content.querySelectorAll('a[href^="redir.aspx"]');		
			var inlines = content.querySelectorAll('img[src^="attachment.ashx"]');		
			var blockedImages = content.querySelectorAll('img[src^="15.0.1263.5/themes/resources/clear1x1.gif"]');
			
			// process sender and recipients 
			var sender	= (document.querySelector('.frm span a') == null) 
						?  document.querySelector('.frm span') 
						:  document.querySelector('.frm span a');
			result.from =  getEmailAddr(sender, baseurl, noreply, contacts);     

			var toList = [];
			var toRecipients = document.querySelectorAll('#divTo span a');
			for (var i = 0; i < toRecipients.length; ++i) {
				var addr = getEmailAddr(toRecipients[i], baseurl, noreply, contacts);
				toList.push(addr);
			}
			result.to = toList.join(';');
	        
			var ccList = [];
			var ccRecipients = document.querySelectorAll('#divCc span a');
			for (var i = 0; i < ccRecipients.length; ++i) {
				var addr = getEmailAddr(ccRecipients[i], baseurl, noreply, contacts);
				ccList.push(addr);
			}
			result.cc = ccList.join(';');

			for (var i = 0; i < headers.length; i+=2) { 
				var rawTag = headers[i].innerText.trim();
				var tag = rawTag.charAt(0).toUpperCase() + rawTag.substr(1);          
				var value = (i < headers.length - 1) ? headers[i+1].innerText.trim() : "";
				switch(tag) {
					case 'To:'   : break;
					case 'Cc:'   : break;
					case 'Sent:' : result.date = value; break;
					default: result.headers[tag] = value; break;
				}
			}

			for (var i = 0; i < links.length; ++i) {
				var link = getUrl(links[i], baseurl);
				links[i].href = link;
			}

			for (var i =0; i < blockedImages.length; ++i) {
				blockedImages.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
			}

			for (var i = 0; i < inlines.length; ++i) {
				var c = getBinary(inlines[i].src);
				var id = "img-" + i;
				inlines[i].href="cid:" + id;

				var extension = ".jpg";
				var contentType = "image/jpeg";

				if (c[0] == 0x89 && c[1] ==0x50 && c[2] == 0x4E && c[3] == 0x47) {
					contentType ="image/png";
					extension = ".png";					
				}				
				else if (c[0] == 0xFF && c[1] ==0xD8 && c[2] == 0xFF) {
					contentType ="image/jpeg";
					extension = ".jpg";					
				}
				else if (c[0] == 0x47 && c[1] == 0x49 && c[2] == 0x46 && c[3] == 0x38) { 
					contentType ="image/gif";
					extension = ".gif";
				}
				else if (c[0] == 0x49 && c[1] == 0x49 && c[2] == 0x2A && c[3] == 0x00) { 
					contentType ="image/tiff";
					extension = ".tif";
				}

				inlines[i].src = "cid:" + id;
				result.inlines.push( { 
					id : id,
					filename: id + extension,
					type: contentType, 
					content: base64Encode(c) 
				} );
			}

			for (var i = 0; i < attachments.length; ++i) { 
				var filename = attachments[i].title.trim();
				var attachment = base64Encode(getBinary(attachments[i].href));
				result.attachments[filename] = attachment;
			}

			result.subject = document.querySelector('.sub').innerText;
			result.text = content.innerText;
			result.html = content.innerHTML;
			result.contacts = contacts;

			return result;
		}, 
		config.url, config.noreply, contacts
	);

	page.onLoadFinished = null;
	INFO("Generating Mail ... ");

	var uuid        = Date.now() + Math.random().toString(36).substr(2, 10);
	var boundary    = 'OWA-MAIL-' 	   + uuid; 
	var boundaryAlt = 'OWA-ALTERNATE-' + uuid;
	var boundaryRel = 'OWA-RELATED-'   + uuid;

	var mail = "";

	mail += ('From: ' + msg.from + '\r\n');
	if (msg.to.length > 0)  mail += ('To:   ' + msg.to + '\r\n');
	if (msg.cc.length > 0)  mail += ('Cc:   ' + msg.cc + '\r\n');
	if (msg.bcc.length > 0) mail += ('Bcc:  ' + msg.bcc + '\r\n');
	mail += ('Date: ' + msg.date + '\r\n');
	mail += ('Subject: ' + msg.subject + '\r\n');
	for (var k in msg.headers) {  mail += (k + msg.headers[k] + '\r\n');  }

	mail += 'MIME-Version: 1.0\r\n';
	mail += ('Content-Type: multipart/mixed; boundary=' + boundary + '\r\n');
	mail += '\r\n';
	mail += ('--' + boundary + '\r\n');

	// Text and HTML content 
	// mail += ('Content-Type: multipart/alternate; boundary=' + boundaryAlt + '\r\n');
	// mail += '\r\n';

	// Text Content
	// mail += ('--' + boundaryAlt + '\r\n');
	// mail += 'Content-Type: text/plain; charset=utf-8\r\n';
	// mail += 'Content-Transfer-Encoding: 7bit\r\n';
	// mail += ('\r\n' + msg.text + '\r\n');

	// HTML Content
	// mail += ('--' + boundaryAlt + '\r\n');
	mail += ('Content-Type: multipart/related; boundary=' + boundaryRel + '\r\n');
	mail += '\r\n';

	mail += ('--' + boundaryRel + '\r\n');
	mail += 'Content-Type: text/html; charset=utf-8\r\n';
	mail += 'Content-Transfer-Encoding: 7bit\r\n';
	mail += ('\r\n' + msg.html + '\r\n');

	INFO("Inline images ... ");
	// Inline images, etc.
	for (var i = 0; i < msg.inlines.length; ++i) {
		var filename = JSON.stringify(msg.inlines[i].filename);
		mail += ('--' + boundaryRel + '\r\n');
		//mail += ('Content-Type: ' + msg.inlines[i].type + '; name=' + filename + '\r\n');
		mail += ('Content-Type: image/jpeg; name=' + filename + '\r\n');
		mail += ('Content-Disposition: inline; filename=' + filename + '\r\n');
		mail += ('Content-Transfer-Encoding: base64\r\n');
		mail += ('Content-ID: <' +msg.inlines[i].id +'>\r\n');
		mail += ('\r\n' + msg.inlines[i].content +'\r\n');		
	}

	// end of multipart/related
	mail += ('--' + boundaryRel + '--\r\n');
	// end of multipart/alternate
	// mail += ('--' + boundaryAlt + '--\r\n');

	INFO("Attachments ... ");
	// Attachments
	for (var attachment in msg.attachments) { 
		var filename = JSON.stringify(attachment);
		var contentType = 'application/octet-stream';

		mail += ('--' + boundary + '\r\n');
		mail += ('Content-Transfer-Encoding: base64\r\n');
		mail += ('Content-Type: ' + contentType + '; name=' + filename + '\r\n');
		mail += ('Content-Disposition: attachment; filename=' + filename + '\r\n');
		mail += ('\r\n' + msg.attachments[attachment] +'\r\n');
	}
	// end of multipart/mixed
	mail += ('--' + boundary + '--\r\n');

	var filename = basedir + uuid + '.txt';
	fs.write(filename, mail, 'w');

	// Save contacts
	contacts = msg.contacts;
	fs.write('contacts.json', JSON.stringify(contacts), 'w');
		
	// send out the email
	var cmdLine = mailer + ' ' + config.email + ' < ' + filename;

	INFO("Executing: " + cmdLine);
	process.execFile('/bin/bash', ['-c', cmdLine], null, 
		function (err, stdout, stderr) {
			if (debugMode) {
				INFO('Logging out... Error: ' + err);
				page.evaluate( function() { document.querySelector('a#lo').click(); } );
				phantom.exit();
			}

			if (err == null) {
				INFO('Deleting mail...');
				fs.remove(filename); 
				page.onLoadFinished = nextMailFn;
				page.evaluate( function() { onClkTb('delete'); });
			}
			else {
				INFO('Skipping mail...');
				// skip to next message
				++msgId;
				page.onLoadFinished = mainPageFn;
				page.evaluate( function() { onClkTb('close'); } );            
			}
		}
	);
};

refreshMsgFn = function() {
	INFO('Refreshing Page');
	page.onLoadFinished = mainPageFn;
	page.open(config.url, function(status) { });
}

mainPageFn = function() {
	waitForPage('.cntnt', 'Main Page');
	resetWatchDog();

	var timeNow = new Date().toString();
	INFO(timeNow + ': processing mail');
	page.onLoadFinished = mailPageFn;   
	var hasMail = page.evaluate( 
		function(msgId) { 
			var mailItems = document.querySelectorAll('.cntnt a[onclick^="onClkRdMsg"]');
			if (mailItems.length > msgId) {
				mailItems[msgId].click();
				console.log('Processing mail #' + msgId);
				return true;
			}
			else {
				// console.log('# Mail Items = ' + mailItems.length);
				// document.querySelector('a#lo').click();
				console.log('No mails');
				return false;
			}
		}, 
		msgId
	);

	if (!hasMail) {
		page.onLoadFinished = false;
		setTimeout(refreshMsgFn, config.refresh);
	}
};


mainPageSortFn = function() {
	waitForPage('.cntnt', 'Main Page');

	INFO('Sorting mails ...');
	page.onLoadFinished = mainPageFn;
	page.evaluate( function() { onClkSrt(7,0); } );
}

loginFn = function() {
	waitForPage('.signinbutton', 'Login Page');

	INFO('Logging in...');
	page.onLoadFinished = mainPageSortFn;
	page.evaluate( 
		function(config) {
			var logonId = (config.domain.length == 0) 
						? config.username 
						: config.domain + '\\' + config.username;
			document.querySelector('#username').value = logonId;
			document.querySelector('#password').value = config.password;
			document.querySelector('.signinbutton').click();
		}, 
		config
	);
};



INFO(new Date().toString() + ': ' + scriptName);
if (fs.isReadable('contacts.json')) { 
	addresses = JSON.parse( fs.read('contacts.json') );
}
fs.write(basedir + scriptName + '.pid', system.pid, 'w');

resetWatchDog();
setTimeout(watchDogFn, config.refresh);

page.onLoadFinished = loginFn;
page.open(config.url, function(status) { });

