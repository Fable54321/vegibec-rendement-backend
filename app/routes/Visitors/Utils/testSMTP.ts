import nodeMailer from "nodemailer";




const from ="timothebissonnette@gmail.com";
const to = "programmation@vegibec.com";


const transporter = nodeMailer.createTransport({
    host: "smtp-pulse.com",
    port: 2525,
    secure: false,
    auth: {
        user: "timothebissonnette@gmail.com",
        pass: "QEEHnYToX6BQmto",
    },
    tls : {
        ciphers: 'SSLv3',
        rejectUnauthorized: false
    }
});


transporter.sendMail({
    from,
    to,
    subject: "test",
    text: "test",
    html: "<b>test</b>",
}).then(console.log).catch(console.error);