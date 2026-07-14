namespace StoreMediaApi.V2.Infrastructure.UnitOfWork;

public interface IUnitOfWork
{
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
