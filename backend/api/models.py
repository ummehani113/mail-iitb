from django.db import models


class MailboxState(models.Model):

    user_key = models.CharField(max_length=64, unique=True)
    uid_validity = models.CharField(max_length=32, blank=True, default="")
    window_days = models.PositiveIntegerField(default=15)
    last_sync_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"MailboxState({self.user_key[:10]}...)"


class DayCoverage(models.Model):


    user_key = models.CharField(max_length=64, db_index=True)
    day = models.DateField()
    message_count = models.PositiveIntegerField(default=0)
    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user_key", "day"],
                name="unique_coverage_user_day",
            )
        ]

    def __str__(self):
        return f"DayCoverage({self.user_key[:10]}... {self.day})"


class EmailMessage(models.Model):

    user_key = models.CharField(max_length=64, db_index=True)
    imap_uid = models.PositiveIntegerField()
    message_id = models.CharField(max_length=255, blank=True, default="", db_index=True)
    received_at = models.DateTimeField(db_index=True)
    received_label = models.CharField(max_length=64, blank=True, default="")
    sender_name = models.CharField(max_length=255, blank=True, default="")
    sender_email = models.CharField(max_length=255, blank=True, default="")
    subject = models.CharField(max_length=1000, blank=True, default="")
    body = models.TextField(blank=True, default="")
    snippet = models.CharField(max_length=400, blank=True, default="")
    excerpt = models.CharField(max_length=1000, blank=True, default="")
    is_read = models.BooleanField(default=True)
    source = models.CharField(max_length=16, blank=True, default="internal")
    updated_at = models.DateTimeField(auto_now=True, db_index=True)
    fetched_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-received_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user_key", "imap_uid"],
                name="unique_user_imap_uid",
            )
        ]
        indexes = [
            models.Index(
                fields=["user_key", "received_at"],
                name="api_email_user_recv",
            )
        ]

    def __str__(self):
        return f"EmailMessage({self.user_key[:10]}... uid={self.imap_uid} {self.subject[:40]})"
