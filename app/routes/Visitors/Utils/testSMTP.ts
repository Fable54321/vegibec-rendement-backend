import nodeMailer from "nodemailer";





const from = "programmation@vegibec.com";
const to ="timothebissonnette@gmail.com";

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